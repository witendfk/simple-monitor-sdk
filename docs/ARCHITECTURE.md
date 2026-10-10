# simple-monitor-sdk 系统架构文档（ARCHITECTURE）

> 版本: 1.0.0 | 日期: 2026-10-10 | 选型与决策理由见 [DESIGN.md](./DESIGN.md)，开放演进见 [tasks/CURRENT.md](./tasks/CURRENT.md)
>
> **文档层级：[PRD](./PRD.md)（什么）→ [SPEC](./SPEC.md)（契约）→ ARCHITECTURE（拓扑）→ DESIGN（为什么）**

## 1. 总体链路

```
SDK（十包）──POST /report/batch──▶ 接入层（zod 校验 + 限流 + apikey，入队返回 204）
                                    │ 只入队不写库
                                    ▼
                              Redis Stream 削峰（MAXLEN ~100000，可降级 Memory 队列）
                                    │ XREADGROUP 批量 100 → 处理 → XACK（pending 重投，3 次进死信）
                                    ▼
                              Ingest（schema 校验/字段投影/部分截断/服务端 fingerprint；二次脱敏 🚧）
                                    │
                                    ▼
                     存储（Memory 形态 ⇄ ClickHouse 明细 + 物化视图；Postgres 元数据 🚧 M7.5）
                                    │
                    ┌───────────────┼────────────────┐
                    ▼               ▼                ▼
              查询 API         告警引擎（5min cron）   错误详情查询时符号化
                    │               │ webhook        │
                    ▼               ▼                ▼
              React 看板         钉钉/企微/Slack…    错误详情符号化堆栈
              （apps/dashboard）   （webhook）        （trace-mapping）
```

**削峰的本质**：上报洪峰不能拖垮 HTTP 响应，否则 SDK 侧重试雪崩。接入层校验后立即入队返回 204。

## 2. SDK 架构

### 2.1 包分层（十包单向依赖）

```
types / shared（契约） → utils（AOP replaceOld、微任务队列、mask 脱敏、堆栈解析、日志）
  → protocol（zod schema + LIMITS，两端共用）
  → core（MonitorClient 类：事件总线、面包屑环形栈、errorId 去重、信封组装、
         BatchSender 批量传输、IndexedDB 缓存、SessionManager、采样）
  → 端侧：browser（唯一 instrumentation 层：xhr/fetch/history/console 补丁、
            错误捕获、行为采集、白屏检测）
          web-performance（纯性能计算引擎：自研 Web Vitals + NT/RT/FPS/LongTask）
  → 框架适配：vue（errorHandler）/ react（ErrorBoundary + 组件名解析）
  → 门面：web（一个 init 全量接入；主入口零框架依赖，react/vue 走子路径 @simple-monitor/web/react|/vue）
```

- **core 是组合根**：`MonitorClient` 类 + 显式依赖注入（transport/storage 皆可替换），`init()` 为创建默认全局实例的语法糖。
- **ADR-3 统一拦截层**：原生 API 包装只发生在 browser 包；web-performance 订阅事件总线拿数据（独立使用时保留自有 proxy 兜底）。
- **多实例语义**：一页一 client（页面级 instrumentation 单例），模块级状态全部进实例。

### 2.2 三条数据流

**错误**：原生补丁/监听 → triggerHandlers 事件总线（handler：silent 检查 → transform 规范化 → 进面包屑 → 条件 send）→ transportData（errorId 抑制客户端重复上报 → 组装信封 + 面包屑 + deviceInfo → 通道状态机选择）→ BatchSender（5s/10 条 flush，gzip，退避重试）→ 失败进 IndexedDB（HTTP 2xx 后删除；sendBeacon 仅尽力送达）。

**性能**：PerformanceObserver（buffered + firstHiddenTime 过滤）→ web-performance MetricsStore → reportCallback（普通 rIC / 紧急同步）→ web 门面转 core 传输（不去重）。

**行为**：browser 采集升格（PV/停留/曝光/data-track）+ core `track()/time()` → BehaviorTracker（按域采样 + 独立信封组）→ 独立于 error/perf 主通道发送。当前独立 BatchSender 未绑定 pagehide/hidden，`BehaviorTracker.flushLeaving()` 为空；行为/API 信封也未复用错误主通道的出口脱敏，修复项见 CURRENT。

### 2.3 已验证的正确设计（重构/演进时保留）

CLS session-window、INP interactionId 聚合 + P98（≤50 取最大 / >50 取 P98）、LCP undefined guard、RT 无 TAO 返回 null stages（不造假数）、reportCallback 解耦契约、urgent 同步上报、事件总线 handler 错误隔离、Mask 分类策略防正则交叠残片。

## 3. 服务端架构（apps/server，NestJS）

### 3.1 模块职责

| 模块                  | 职责                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `report/`             | POST /report/batch：raw body（beacon text/plain 兼容）+ gunzip 中间件 + zod 校验 + apikey 鉴权 + 限流 + 入队              |
| `queue/`              | producer（XADD MAXLEN）/ consumer（XREADGROUP → ingest → XACK；死信）；Memory/Redis 双实现                                |
| `ingest/`             | schema 校验、字段投影、部分截断、kind 归一化和服务端 fingerprint（FNV，含首帧位置）；二次脱敏与全字段截断待补             |
| `storage/`            | **DIP 三接口双实现**：IEventQueue（Memory/RedisStream）、IEventStorage（Memory/ClickHouse）、IRateLimiter（Memory/Redis） |
| `query/`              | /api/overview、/api/errors、/api/errors/:fp（symbolicatedStack）、/api/performance、/api/behaviors                        |
| `alert/`              | 规则引擎（error_spike / perf_threshold）+ 冷却 + webhook（SSRF 双道防护：BlockList + DNS 复核 + 重定向逐跳）              |
| `auth/` + `projects/` | ApiKeyGuard（x-api-key → /api/\*\* 全覆盖）+ 项目注册表（PROJECTS_JSON / 内存）                                           |
| `sourcemap/`          | 上传 API（独立 20MB parser）+ SourcemapService（trace-mapping，release+URL 精确/后缀匹配，LRU 缓存）+ bin/sourcemap-cli   |

### 3.2 目标形态（M7.5 重构，落地设计）

> 定位：结构从第一天就是终局形态，功能按里程碑逐步完备——不再有「demo 表」。完整 DDL 原稿见 git 历史（cde90a5）。

**职责铁律**：ClickHouse 只存 append-only 的事件事实；一切可变状态（Issue 状态、告警规则、项目配置）在 Postgres；查询层只读；Gateway 不碰存储细节。

**ClickHouse：按 kind 分表**（替代 M4 单宽表；每表列即该类事件完整形状，月分区）。总量、趋势、分位数优先读预聚合；错误详情、最近事件、漏斗和留存须读取限定项目与时间范围的明细，M8/M9 落地前为这些查询验证排序键与延迟预算。

| 表                | 关键形状                                                                                                                                                                   | ORDER BY                                  | TTL   | 物化视图                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `error_events`    | error_type 分类 + resource_kind + message_head（128 字符，指纹分组冗余列）+ fingerprint（沿用现有 FNV-1a；变更算法须迁移旧分组）+ stack_frames + http 上下文 + breadcrumbs | (project_id, error_type, fingerprint, ts) | 90 天 | 错误组（按指纹聚合）                                                                             |
| `perf_events`     | 一行一指标（metric/value/score/detail JSON）                                                                                                                               | (project_id, metric, ts)                  | 90 天 | perf_stats：小时桶 p50/p75/p95（quantileTDigestState，含 release 维度——发版对比的基础视图）      |
| `behavior_events` | behavior*type 四类 + PV 来源归因列（referrer_host/utm*\*）+ dwell active_ms + name/props                                                                                   | (project_id, behavior_type, ts)           | 90 天 | pv_stats：小时 PV + uniqState(tracker_id) UV；session_id 仅用于会话数。采样小于 1 时披露估算口径 |
| `api_events`      | method/url/status/duration_ms/is_slow/trace_id；成功请求样本须带采样率                                                                                                     | (project_id, url, ts)                     | 30 天 | api_stats：小时计数与可合并的 quantile state；成功量按采样率估算，失败量从 error.http 汇总       |

**Postgres：元数据与状态域**：users / projects（**双密钥**：public_key 上报身份 + secret_key_hash 管理身份——P3 权限分离的数据地基）/ project_members / **issues 状态机**（UNIQUE(project_id, fingerprint)；status open/resolved/ignored；first_seen/last_seen/event_count/first_release——退出「查询时聚合」）/ alert_rules + alert_history / releases / sourcemap_artifacts。

**服务分层**（apps/server 重构目标）：gateway（public_key 鉴权 → **projectId 服务端覆写**（防客户端篡改）→ 令牌桶 Lua 限流 → 入队）→ processors（error/perf/behavior/api 分域消费者：指纹归一 → CH 分表写入 / PG Issue 更新；重试耗尽进死信）→ storage（clickhouse/postgres 双仓库，每事件域一个 repository）→ query（overview/errors/performance/visits/api）+ alert + settings。事件级幂等须先在 SPEC 定义稳定 ID 和重试窗口，再确定去重标记与 CH 写入、PG Issue 更新的失败恢复顺序；单独先做 SETNX 会在写库失败后误抑制重试。接口化 `IProjectStore / IIssueStore / IAlertRuleStore / IEventQueue / IEventStorage(分表)`——Memory 实现永久保留为零依赖形态，`NODE_STORAGE=memory|infra` 一键切换（DIP 纪律不变）。

实施切分 P1-P5 与逐批验收见 [tasks/CURRENT.md §3.1](./tasks/CURRENT.md)。GeoIP 仅预留列、不引依赖。

## 4. 存储拓扑（现状）

- **Memory 形态**（零依赖起步、CI/e2e 使用）：内存事件数组 + apikey 查询隔离；当前按 `apikey+errorId` 永久跳过错误，误抑制合法重复/跨会话错误，且 Set 不随事件淘汰。没有可用的服务端事件级幂等。全链路 e2e 在此形态跑。
- **ClickHouse 形态**：单宽表 `events`（MergeTree，PARTITION BY 月，ORDER BY (apikey,kind,type,ts)，TTL 30 天）+ 错误组/性能分位物化视图。当前行为/API 只保存通用列，事件名/属性/PV 来源及请求详情未入库；`/api/behaviors` 与 Memory 形态不等价。⚠️ 真实联调待 docker 环境。
- **Postgres 元数据** 🚧：M7.5 P1 落地 projects 双密钥/users/members/issues 状态机/alert_rules/releases/sourcemap_artifacts（现内存/PROJECTS_JSON 过渡）。

## 5. 看板（apps/dashboard）

Vite + React + ECharts 自建（ADR-5）。现有视图：概览（统计卡 + Top 错误柱图，10s 刷新）/ 错误列表（发版过滤 + 新错误徽标）/ 错误详情（符号化堆栈高亮 + 面包屑时间线）/ 性能分位 / 告警管理（规则 CRUD/启停/触发记录）。目标视图与 M7.5/M8/M9/M10 增量见 [PRD §6](./PRD.md)。

## 6. 部署

- **零依赖形态**：`pnpm dev` 起 server（tsx，需 Node ≥20）+ dashboard，Memory 存储，SDK dsn 指向 localhost。
- **基础设施形态**：当前 docker-compose 仅启动 Redis 与 ClickHouse，server/dashboard 在本地运行，CH 建表见 `docker/clickhouse/init.sql`。Postgres 与服务容器属 M7.5 目标；真实环境联调验证待办见 CURRENT。
- **演示链路（30 秒）**：`demo:full` 一条命令起全链路（demo dsn 相对路径 + vite 代理，DEMO_TARGET 可切 mock/真服务端）→ demo 页触发错误 → 看板趋势可见 → 详情页符号化堆栈 + 面包屑时间线。

## 7. 工程体系

### 7.1 测试金字塔

纯函数单测（239 个为底座）→ replace 层 jsdom 集成（mock XHR/fetch）→ 契约测试（protocol schema 两端跑）→ oracle 一致性（自研 web-vitals vs 官方库，conformance job）→ e2e（内存形态全链路 + gzip 回归）→ 压测（k6 脚本就绪，实测待 docker）。

### 7.2 CI 门禁

三段 typecheck（packages/server/dashboard）→ lint:ci（error=0，warning 基线只减不增）→ build → test；独立 conformance job（Chromium，oracle 偏差断言）。十包 gzip 预算脚本已写好，但 CI 尚未调用 `pnpm size`；浏览器矩阵、真实 Redis/CH 故障集成、codecov 未落地。

### 7.3 修复与复审 SOP（问题修复一律五步）

1. **认领 = 先写验收条件**（先改文档再改代码）：可执行的测试场景或攻击用例，不写验收条件不动手。
2. **声明同步检查**：grep 该能力的全部注释/README/文档声明，改完实现必须回改声明。
3. **按深度标准修**：安全类以绕过者视角列 ≥3 攻击变体并脚本实证，实证用例转回归测试；异步/可靠性类必须回答「连续失败两次会怎样」，unhandled rejection 零容忍；数据删除/外部 IO 显式论证状态变更顺序与失败路径（数据在哪、如何重放、上限多少）。
4. **验证闭环**：行为级回归测试锁定 → 全门禁绿 → 勾销条目 + 同步边界声明。
5. **复审关闭**：修复 ≠ 关闭，按验收条件独立复核通过才算关闭。

**异步纪律**：监控 SDK 自身 fire-and-forget 链（send/flush/timer 回调）必须有就地 try-catch；新增集成测试必须真实执行到目标代码路径（本地绿 ≠ CI 绿）。

**代码评审**：一律按 `.zcode/skills/code-review-expert/SKILL.md`（四清单 + 项目附加必查项，问题带 file:line 分级）。

### 7.4 写作纪律

已实现能力须有验证依据；规划设计显式标 🚧（如 ADR-10 多端支持）。产品承诺归 PRD，wire 格式以 `packages/protocol` schema 为准并由 SPEC 解释，现状与目标拓扑归本文，取舍理由归 DESIGN，进度只在 CURRENT 维护；历史问题与执行记录冻结于 [tasks/LEDGER.md](./tasks/LEDGER.md)。面向使用者的接入指南待项目落地后补，不复制四件套内容。

## 8. 架构演进路线

当前焦点与路线图（M7.5 存储架构 / M8 访问域 / M9 埋点分析 / M10 AI 诊断 + 独立权限分离切片）见 [tasks/CURRENT.md](./tasks/CURRENT.md)。
