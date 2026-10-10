# simple-monitor-sdk 技术规格说明书（SPEC）

> 版本: 1.0.0 | 日期: 2026-10-10 | 真值来源：`packages/protocol`（schema 即契约，本文是人读投影）
>
> **文档层级：[PRD](./PRD.md)（什么）→ SPEC（契约）→ [ARCHITECTURE](./ARCHITECTURE.md)（拓扑）→ [DESIGN](./DESIGN.md)（为什么）**
>
> 状态标注同 PRD：✅ 已实现并验证 ｜ 🚧 规划 ｜ ✂️ 明确不做。schema/LIMITS 与本文不符时，以 `packages/protocol` 源码为准并回改本文。

## 1. 概述与术语

| 术语                  | 含义                                                              |
| --------------------- | ----------------------------------------------------------------- |
| 信封（Envelope）      | 批量上报传输单元，一条信封含多条事件                              |
| Event（kind）         | 事件判别联合：`error` / `perf` / `replay` / `behavior` / `api`    |
| errorId               | SDK 侧 message 级 hash，流量去重防刷屏                            |
| fingerprint           | 服务端 hash（type + message + 堆栈首帧 url:line:col），分析分组用 |
| sessionId / trackerId | sessionStorage 级会话 / localStorage 级设备标识                   |
| viewId                | SPA 路由级标识，采集时刻打标                                      |

## 2. SDK 行为规格

### 2.1 初始化与生命周期

- `init(options)` = 创建默认全局 `MonitorClient` 的语法糖；模块级状态全部进实例（ADR-1）。
- **一页一 client**：页面级 instrumentation 单例，首个成功 init 的 client 独占采集器；换 client 告警忽略。`destroy()` 后同页重建不支持（原生补丁保留旧实例闭包，重置请刷新页面）；iframe/微前端多实例不受限。✅
- 全链路 `send/flush/buildEnvelope/序列化` 就地 try-catch，监控自身不允许向宿主抛异常、不允许产生 unhandled rejection。✅
- SSR 安全：无 `window` 环境 init 只绑配置不装载采集器。✅

### 2.2 采集语义

| 域                | 规则                                                                                                                                                 | 状态                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| JS / Promise 错误 | `window.onerror` + `unhandledrejection`；silent 检查 → transform 规范化 → 进面包屑 → 条件发送                                                        | ✅                                 |
| 资源错误          | img/script/link `error`；`resourceKind` 拆分 script/image/css/media/other（localName 映射）；`silentResource` 独立开关                               | ✅                                 |
| HTTP 异常         | 4xx/5xx/status 0 走 `FETCH_ERROR`；2xx 只进面包屑；`filterXhrUrlRegExp` 命中完全不监控                                                               | ✅                                 |
| 白屏              | load 后 16 点视口采样（elementsFromPoint），命中全空判定白屏 → 独立错误事件                                                                          | ✅                                 |
| PV                | 首次加载（loadType: navigate/reload/back_forward）+ 路由变更；同 URL 连续去重；会话内仅首 PV 携带 `referrerHost` + `utm_source/medium/campaign`      | ✅                                 |
| 停留时长          | `PAGE_DWELL`：visibilitychange 累计 + 离场期 flush                                                                                                   | ✅ 时长计算；🚧 行为通道离场 flush |
| 曝光              | IntersectionObserver + 停留 ≥500ms 才有效；同 selector 1s 节流；每 view 去重                                                                         | ✅                                 |
| 声明式埋点        | `data-track`（click + form submit capture 委托）、`data-expose`（曝光）                                                                              | ✅                                 |
| Web Vitals        | FP/FCP/LCP/CLS/INP 自研，语义对齐官方库（oracle 偏差断言：LCP ±50ms / CLS ±0.02）；NT/RT/FPS；LongTask 三档分布（50-100/100-200/≥200ms）+ Top-N 归因 | ✅                                 |
| 性能归一          | `PerfMetric.value` 一律 number；富信息放平级 detail，无法归一的跳过不造假数；score 钳制 [0,1]                                                        | ✅                                 |

### 2.3 手动 API

| API                                       | 语义                                                      | 状态 |
| ----------------------------------------- | --------------------------------------------------------- | ---- |
| `log()`                                   | 分级日志上报                                              | ✅   |
| `track(name, props)` / `time(name)`       | 自定义事件 / 测速；duration 非有限数/负数/超 24h 静默丢弃 | ✅   |
| `captureException` / `captureMessage`     | 手动异常上报                                              | 🚧   |
| `setUser` / `setTag`                      | 全局属性附加                                              | 🚧   |
| `ignoreErrors` / `allowUrls` / `denyUrls` | 标准错误过滤                                              | 🚧   |
| consent mode                              | 未同意只采集错误不采集行为                                | 🚧   |

## 3. 协议 v1（`@simple-monitor/protocol`）

zod schema 为单一事实来源，TS 类型由 zod 推导；SDK 发送端（生产 build 摇树校验）与服务端接收端共用同一 schema，契约测试两端跑。

### 3.1 信封

```ts
{
  protocolVersion: 1,
  sentAt: number,                     // SDK 发送时刻 ms
  auth: { apiKey, release?, env?, sdk: { name, version } },
  session: { sessionId, trackerId },
  context: { page, referrer?, viewport, viewId?, device? },
  events: Event[]
}
```

### 3.2 事件判别联合

```ts
{ kind: 'error',    error: ErrorPayload, breadcrumbs?: Breadcrumb[] }
{ kind: 'perf',     metrics: PerfMetric[] }
{ kind: 'replay',   rrweb: { events: unknown[] }, reason?: 'error' } // 占位，回放预留
{ kind: 'behavior', behavior: BehaviorPayload }  // v1.1 加性
{ kind: 'api',      api: { method, url, status, durationMs, slow?, traceId? } } // v1.1 加性

// BehaviorPayload =
//   { behaviorType: 'page_view', url, loadType?, referrerHost?, utmSource?, utmMedium?, utmCampaign? }
// | { behaviorType: 'page_dwell', activeMs, startTime, endTime }
// | { behaviorType: 'expose', name, selector?, dwellMs }
// | { behaviorType: 'track', name, props?, from: 'api' | 'declarative' }

// ErrorPayload: type / message / name? / level? / stackFrames?[{url,func,line,column}] /
//   errorId?(SDK 流量去重) / componentName? / resourceKind? /
//   http?: { method?, url?, status?, elapsedTime?, traceId?, reqData?, responseText? }
```

### 3.3 LIMITS（结构约束进 schema，语义约束两端各自截断）

「规格值」列为规范上限；实现偏差只出现在「现状偏差」列并指向 [CURRENT §3.3](./tasks/CURRENT.md)——偏差修复勾销后须清空偏差列、必要时回改规格值，规格列保持纯规范。

| 字段                      | 规格值（LIMITS）                                                            | 现状偏差（→CURRENT §3.3）              |
| ------------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| message                   | 1024 个 UTF-16 字符                                                         | —                                       |
| stack                     | 32KB（SDK 目标上限）                                                        | 服务端二次截断未全覆盖（随 P0）         |
| HTTP reqData/responseText | 2048 个 UTF-16 字符                                                         | —                                       |
| 面包屑单条                | data 序列化后 512 个 UTF-16 字符，≤50 条（钳制 [1,50]）                     | 服务端截断未全覆盖（随 P0）             |
| behavior name             | 128 字符                                                                    | —                                       |
| trackProps                | 序列化 ≤2048B 且键数 ≤32；代码埋点与 `data-track-props` 同规则              | 声明式入口未限制（P2）                  |
| 单会话 behavior 事件      | 采集预算 500 条（仅计行为事件，到限丢新）；待发送缓冲超限丢最旧             | 成功 API 计入同一预算，待拆分（P2）     |
| 接入层 body               | JSON 256KB（/api/sourcemaps 独立 20MB）；gzip 压缩输入 1MB                  | gzip 解压输出无上限（P1 有界解析与采样）|
| beacon 信封               | >64KB 按 UTF-8 字节拆批，每个事件恰好进入一个分片                           | 按 UTF-16 判长且分片偏移错误（P1 拆批） |

### 3.4 三份规格

1. **指纹分工**：SDK errorId = message 级 hash（流量去重，`maxDuplicateCount` 兜底）；服务端 fingerprint = (type + message + 堆栈首帧 url:line:col) hash。流量侧粗、分析侧细。
2. **采样**：错误 100% 不采样；perf 按 `sampleRate`、行为按 `trackSampleRate`、成功请求按 `apiSampleRate`（默认 0.1）在采集层过滤（省流量也省内存）。
3. **隐私目标**：默认脱敏（手机号/身份证/卡号/凭证/JWT → `[phone]` 等分类替换）+ 全字段截断；错误/性能与行为/API 信封均在出口兜底，服务端独立二次脱敏；`enablePrivacyMask` 默认开。当前行为属性、PV/成功 API URL 和声明式属性可绕过 SDK 脱敏，服务端也未执行二次脱敏，见 CURRENT 评审修复清单。

### 3.5 版本演进纪律

- `PROTOCOL_VERSION` 当前为 1；**加性演进**（只增字段/kind，不破坏既有结构），v1.1 行为域扩展未升版本。
- **旧服务端兼容**：behavior/api 事件固定走独立信封组（不经 dsn 回落与 error 信封合并）；旧端拒绝该组时直接丢弃，不会连带错误/性能主通道。当前发送端没有按 4xx 内容剔除 kind 后重试的逻辑。
- 当前 CH `kind` 列是 `LowCardinality(String)`，新增 kind 无需改枚举；将来若改为 Enum，迁移须先扩展允许值。

## 4. HTTP API 契约

### 4.1 数据接入

`POST /report/batch` ✅

- 请求体 `auth.apiKey` 为上报身份；`/report/batch` 不要求 `x-api-key` 请求头（sendBeacon 无法附加自定义头）。普通请求使用 `Content-Type: application/json`，sendBeacon 使用 `text/plain`；gzip 请求使用 `Content-Type: application/gzip`，服务端据此解压。
- 处理链：body 解析 → zod 校验（protocol schema）→ 信封 apikey 鉴权 → 按信封限流 → 入队 → `204`（只确认入队，不确认落库）。
- 错误响应：400 校验失败（整包拒绝）｜403 未注册 apikey｜413 超 body 上限｜429 限流（带 `Retry-After`）。
- 幂等：当前没有正确的服务端事件级幂等；SDK errorId 用于客户端流量去重，fingerprint 用于错误分组。Memory 存储现按 `apikey+errorId` 永久去重，会误删跨会话及 SDK 允许的合法重复错误，不能作为重试幂等。M7.5 P4 须先定义稳定的事件 ID 与去重窗口，再实现重放去重。

### 4.2 查询 API（`/api/*` 当前使用 `x-api-key`，权限分离见 CURRENT P0）

| 端点                                               | 内容                                                                                      | 状态                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| `GET /api/overview`                                | 概览统计                                                                                  | ✅                      |
| `GET /api/errors`                                  | 错误分组列表（当前支持 `limit`、`sinceMinutes`；`release` 过滤与 `isNewInRelease` 🚧 M8） | ✅ 基础列表             |
| `GET /api/errors/:fingerprint`                     | 详情 + 样本 + symbolicatedStack                                                           | ✅                      |
| `GET /api/performance`                             | 性能分位（`metric`、`sinceMinutes`）                                                      | ✅                      |
| `GET /api/behaviors`                               | 行为事件查询；Memory 返回行为属性，当前 CH 仅返回类型/时间/会话/页面                      | ✅ 端点；🚧 CH 明细对齐 |
| `GET /api/visits` `/api/requests` `/api/resources` | 访问域 / 请求域 / 慢资源                                                                  | 🚧 M8                   |
| 全端点横切                                         | 时间范围（from/to）+ 维度过滤（release/env/page/device/viewId），SQL 全参数化             | 🚧 M8                   |

### 4.3 SourceMap 与告警

- `POST /api/sourcemaps`：map 内容 fail-fast 校验，独立 20MB body 上限；配套 `bin/sourcemap-cli`（零依赖，CI 构建后步骤可用）。✅
- 告警规则 CRUD + 触发记录 API（/api/alerts/\*），规则归属项目隔离。✅

## 5. 服务端处理规则

| 项                | 规格                                                                                                                                                                            | 状态                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 限流              | 1000 信封/min/项目（Redis `INCR key:{minute}` EXPIRE 60）；Memory 实现兜底                                                                                                      | ✅                      |
| 队列              | Redis Stream `XADD MAXLEN ~ 100000`（达到上限丢最老）；XREADGROUP 批量 100 → 处理 → XACK；失败重试 3 次 → 死信流 `report:dead`；未被裁剪的 pending 消息可重投                   | ✅ ⚠️ 真实 Redis 联调待 |
| 崩溃自愈          | 消费循环为监管循环（supervisedLoop），内层意外终止退避重启                                                                                                                      | ✅                      |
| 去重              | SDK errorId 抑制客户端重复上报；服务端 fingerprint 只做分组，重复消费会重复计数；事件级幂等 🚧 M7.5 P4                                                                          | 🚧                      |
| ingest            | 目标：字段白名单 → 二次脱敏 → 全字段截断 → kind 归一 → fingerprint。现状：schema 校验与字段投影、部分截断及 fingerprint 已实现；无二次脱敏，stack/面包屑/http body 截断未全覆盖 | ✅ 部分；🚧 隐私兜底    |
| 告警公式          | error_spike：近 15min 错误数 > max(20, 前 6h 均值×3)；perf_threshold：如 LCP P75 > 4000ms 持续 2 桶；minCount 低流量兜底                                                        | ✅                      |
| 告警防轰炸        | webhook 投递后 15min 冷却；投递失败不进冷却，下轮重试；fetch 5s 超时                                                                                                            | ✅                      |
| webhook SSRF 防护 | 双道：字面值 `net.BlockList`（私网/保留/环回段）+ 发送前 DNS 解析复核 + 重定向逐跳复核（`redirect: 'manual'`，≤3 跳）；残余 TOCTOU 窗口已在 server README 声明                  | ✅                      |
| 权限模型          | 现状：公开上报 key（apikey）同时放行 `/api/**` 查询与管理接口——**公网部署前置缺口**                                                                                             | 🚧 P0 切片              |

## 6. 已知边界声明

- fetch 自循环：XHR/fetch 双通道均识别 SDK 自身上报地址并跳过。✅
- 慢查询/物化视图仅 ClickHouse 形态有效；Memory 形态为简化实现。当前两种形态的行为/API 明细及错误重复计数尚不等价，修复任务见 CURRENT。
- fetch 响应采样目前对无 `Content-Length` 的文本响应使用 `clone().text()` 全量读取；目标是有界读取样本，不让监控采集随正文持续占用宿主内存。
- `dd.tracking` 类第三方 Cookie / 跨子域 trackerId 合并：未做。
- 其余开放风险与待办见 [tasks/CURRENT.md](./tasks/CURRENT.md)。
