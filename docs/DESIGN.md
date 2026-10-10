# simple-monitor-sdk 技术设计文档（DESIGN）

> 版本: 1.0.0 | 日期: 2026-10-10 | ADR 决策记录：先立后动工，实现与决策冲突时先改文档再改代码
>
> **文档层级：[PRD](./PRD.md)（什么）→ [SPEC](./SPEC.md)（契约）→ [ARCHITECTURE](./ARCHITECTURE.md)（拓扑）→ DESIGN（为什么）**

## 1. 决策索引

| ADR | 决策 | 状态 |
|---|---|---|
| ADR-1 | 多实例化：废弃全局单例，`MonitorClient` 类 + 默认全局实例 | ✅ M1 落地 |
| ADR-2 | 契约先行：`@simple-monitor/protocol` 包（zod 单一事实来源） | ✅ M0 落地 |
| ADR-3 | 统一拦截层：全项目只允许一处打补丁 | ✅ M1 落地 |
| ADR-4 | 存储：Postgres（元数据）+ ClickHouse（事件），放弃 Mongo | ✅ 选型定；落地设计见 [ARCHITECTURE §3.2](./ARCHITECTURE.md)（M7.5） |
| ADR-5 | 看板自建（React + ECharts），Grafana 仅留可选导出 | ✅ M5 落地 |
| ADR-6 | 自研 web-vitals 保留，以官方库为 oracle | ✅ M3 落地 |
| ADR-7 | 追踪标准：W3C Trace Context 优先 | ✅ M1 落地 |
| ADR-8 | 行为域埋点：采集升格而非新起炉灶，协议加性演进 | ✅ M7 落地 |
| ADR-9 | AI 诊断：只生成建议，不执行修复，人工闭环 | 🚧 M10 |
| ADR-10 | 多端支持：原生 wx 打底 + uniapp 适配层（仅小程序编译目标），Taro 不做 | 🚧 M11/M12 |

## 2. ADR 详述

### ADR-1 多实例化：废弃全局单例

**背景**：状态曾全挂 `window.__Monitor__`（_support 单例、CCP 模块级队列、metricsStore）——多实例互串、SSR 崩溃、无法隔离测试，是历史问题近半条目的共同根源。

**决策**：core 改为 `MonitorClient` 类；`init()` 是「创建默认全局实例」的语法糖（保零配置接入）；模块级状态全部进实例。默认 client 兼容出口保平滑迁移。

### ADR-2 契约先行：protocol 包

zod schema 为单一事实来源，TS 类型由 zod 推导；SDK 发送端（生产 build 摇树校验）与服务端接收端共用同一 schema；信封带 `protocolVersion`。契约测试的基石，monorepo 独有优势。

### ADR-3 统一拦截层：全项目只允许一处打补丁

browser 包是唯一 instrumentation 层（xhr/fetch/history/console 包装只发生在此）；web-performance 降级为纯计算引擎，订阅事件总线拿请求数据。消灭双层包装与两套幂等标记。独立使用 web-performance 时保留自有 proxy 兜底。

### ADR-4 存储：Postgres（元数据）+ ClickHouse（事件），放弃 Mongo

事件明细是 OLAP 负载（海量写、时间+维度聚合、TTL），ClickHouse 的 MergeTree/TTL/物化视图/`quantileTDigestState` 为此而生，是监控后端含金量最高的学习内容；项目/告警规则/SourceMap 工件等小量事务数据放 Postgres。

**落地级设计**：已并入 [ARCHITECTURE §3.2](./ARCHITECTURE.md)——CH 按 kind 分四表（error/perf/behavior/api，分区+TTL+物化视图）替代单宽表；PG 元数据全量 DDL（双密钥 projects / issues 状态机 / alert_rules / releases / sourcemap_artifacts）；服务分层 gateway → processors → storage → query；实施切 P1-P5，Memory 实现保留为零依赖形态（DIP 不变）。完整 DDL 原稿见 git 历史（cde90a5）。

**回退条款**：ClickHouse 一个月窗口内若学习成本失控，可退 Mongo + 自实现近似分位数。

### ADR-5 看板自建（React + ECharts）

作品集含金量与产品完整度双考量；Grafana 仅留可选导出。六视图：概览 / 错误列表+详情（符号化堆栈+面包屑时间线）/ 性能趋势（按 release 对比）/ 慢资源 / 设备分布 / 告警配置；后续对齐目标见 [PRD §6](./PRD.md)。

### ADR-6 自研 web-vitals 保留，以官方库为 oracle

fixture 页面 playwright 双跑（自研 vs `web-vitals` 官方库，同一 PerformanceObserver 条目流），断言 LCP/CLS/INP 偏差在容差内（±50ms / ±0.02）进 CI。叙事从「照规范写的」升级为「有机制保证与官方一致」。调试经验：程序化 click 的 interactionId=0 会被两引擎一致拒绝，conformance 必须用真实输入驱动。

### ADR-7 追踪标准：W3C Trace Context 优先

实现 `traceparent` 头（自定义 Trace-Id 字段名保留可配）；上报 traceId 与请求头对齐，链路才串得起来。对齐 OpenTelemetry 生态，未来可接任何 APM 后端。

### ADR-8 行为域埋点：采集升格 + 协议加性演进

定位早含「行为」，协议规格已预留——M7 兑现而非新起炉灶。三件套：

- **自动采集升格**：PV（首次加载 + onRouteChange）、停留时长（visibilitychange 累计 + 离场期 flush）、曝光（IntersectionObserver，每 view 去重）升格为一等事件；面包屑继续承担错误上下文。
- **代码埋点 API**：core `track(name, props)` / `time(name)`；`log()` 语义不变。
- **声明式埋点**：`data-track`（点击 + form submit capture 委托）+ `data-expose`（曝光）。

协议只增 kind（behavior/api），`PROTOCOL_VERSION` 维持 1。行为/api 固定独立信封组；旧端 4xx 拒绝该组时直接丢弃，错误/性能主通道不受影响。当前没有按 4xx 内容剔除 kind 后重试的实现。`kind api` 默认采样 0.1（可调），复用 `filterXhrUrlRegExp` 过滤规则；M8 的调用量和成功率必须校正样本，不能把抽样后的成功数直接当全量。

**实现细则（对标复盘吸收）**：PV 同 URL 去重 + loadType；曝光 ≥500ms 停留 + 1s 节流 + 每 view 去重；防风暴 LIMITS（name ≤128 / props ≤2KB ≤32 键 / 单会话上限丢最旧）；LongTask 三档分档；白屏 16 点检测；beacon >64KB 拆批 + `online` 即时重放。**image 通道降级经评估放弃**：204 空响应对 Image 只触发 onerror，送达不可确认会引入假成功。

**明确不做**：可视化圈选——选择器管理 + DOM 脆弱性成本远超收益，出现真实业务需求再立项。注意 M1 曾按「配置项=承诺」纪律删除 enableTrack 死配置，M7 重新引入的 track 选项为实装语义。

### ADR-9 AI 诊断：只建议不执行，人工闭环

把「看懂一个错误」的成本从人工读堆栈降到读结构化结论。三条边界：

1. **输入即资产**：诊断上下文全部复用既有查询能力（错误聚合 + symbolicatedStack + 面包屑时间线 + release/env）；无 sourcemap 时在结论中明确降级声明。
2. **只建议不执行**：M10 无任何工具执行面（不读仓库、不写代码、不建 PR）；输出必须带 evidence（堆栈帧/面包屑引用）供人工核对。
3. **外部数据当数据**：错误消息/面包屑/页面 URL 是宿主页面可控内容，一律注入数据段并与 system 段隔离，防 prompt 注入。

工程形态：provider 接口 + OpenAI 兼容默认实现（env 可配，不锁厂商）；**不引 Agent 框架**，单次结构化调用起步，输出 JSON 经 zod 校验（进契约测试）；诊断结果属小量事务数据（ADR-4 归 Postgres），IDiagnosisStore 内存先行；无 LLM env 时模块整体禁用（501 明确降级）。护栏：同 fingerprint+堆栈 hash 缓存、按管理身份限流、输入按 LIMITS 截断；发送至外部 provider 前须明确项目级启用、字段最小化、再次脱敏和日志留存策略。**证据快照**——落库时把 evidence 引用的堆栈帧/面包屑摘要一并快照（事件 TTL 到期后结论仍须能核对）。

### ADR-10 多端支持：原生 wx 打底 + uniapp 适配层

**背景**：产品定位含小程序生态；本项目本就源自一套支持 wx 的监控框架，遗留资产（`wxRequestPost` 通道、`isWxMiniEnv`/`getCurrentRoute`/`getAppId`、Wx 事件类型）仍在代码中。ADR-1/3 落地后 core 引擎环境无关、instrumentation 只在平台包——补小程序 = 新增平台包，core 微调、protocol 与服务端零改动。

**决策（两步走）**：

1. **`packages/wx` 原生微信小程序包（M11）**：App/Page 生命周期包装 + 覆写 `wx.request` + `wx.getPerformance()` 映射；错误（App.onError/onUnhandledRejection/onPageNotFound）/ HTTP（4xx/5xx → error.http，成功 → kind api）/ PV + 来源归因（launchOptions 的 path/query/**scene 场景值**/referrerInfo，比 web UTM 更全）/ 停留时长（onShow/onHide）/ 曝光（`wx.createIntersectionObserver` + class 选择器扫描，≥500ms 停留 + 每 view 去重）/ 声明式埋点（无 DOM 委托，组件包装器 + track() API）/ 传输（wx.request 批量；App.onHide 即离场 flush + EnvelopeCache 换 wx storage 实现下次启动重放）。遗留 wx 通道与类型随之转正，P2 挂账中的 wx 静默开关条目随本切片处理。
2. **`packages/uniapp` 适配层（M12，依赖 M11）**：Vue 插件（`app.use(monitor)`）+ 页面级 mixin（onShow/onHide 取 PV 与停留）+ 框架错误钩子（Vue errorHandler + wx.onUnhandledRejection）。**只服务小程序编译目标**；运行时层（传输/存储/曝光/错误兜底）复用 wx 包——uniapp 编译到微信端后仍是 wx 运行时，覆写 wx.request 全局生效。H5 编译目标不做，引导用户直接用 `@simple-monitor/web`。

**为什么不只做 uniapp / 为什么原生先行**：原生形态 instrumentation 最深、语义最干净（框架未接管 App()/Page()，一切可包装），是监控 SDK 的含金量部分；先做 uniapp 的话底层 70% 运行时能力仍要先写一遍，等于绕路。

**明确不做**：Taro（与 uniapp 解决同一问题，一个适配层就够，真需求再立项）、支付宝/抖音等直出独立适配、uniapp H5 目标、Flutter。

**工程边界（与 web 的验证深度差异，如实声明）**：CI 无真机 e2e——验证 = 模拟 wx API 的 jsdom 单测 + protocol 契约测试两端跑 + 人工真机冒烟；上报域名必须在小程序后台配置 request 合法域名（进接入文档）；基础库门槛 IntersectionObserver ≥2.7、getPerformance ≥2.11（进兼容矩阵）；Web Vitals/LongTask/FPS 无对应 API，明确裁剪不造假数。

## 3. 裁剪决策（时间不够按序砍，砍序本身是决策）

- **SDK 侧裁剪线**：软导航 vitals → rrweb 回放（预留延后，非裁弃——协议已占位，不伤架构）→ Element Timing / Long Task attribution → 多租户权限细化。
- **M7-M9 裁剪线**：可视化圈选（ADR-8 取舍，明确不做）→ 地域/IP 归属（不引 GeoIP）→ 留存小时/跨月粒度（按日即可）→ 事件属性精确聚合（Top-N 近似可接受）。
- **M10 演进线（明确不在 M10 范围，按序解锁）**：仓库只读上下文 → 自动修复 PR（写权限 + 沙箱 + 验证管线 + 默认人工确认）→ 告警联动自动诊断 → 流式输出。

**不可砍下限**：M0 协议、M1 重构、M2 可靠性、M4 存储选型、错误分组、看板核心视图；协议加性演进纪律、按域采样、曝光去重；输出 schema 校验、prompt 注入隔离、人工闭环。

## 4. 对标借鉴纪律

对参考项目对标的吸收原则：**已验证的实现细节直接吸收**（M7 行为域细则即产出一）；**架构级借鉴先圈优先级再立项**（服务端 10 项可取清单见 [tasks/CURRENT.md](./tasks/CURRENT.md) 候选池）；**本项目领先面守住不换**：ClickHouse 明细生命周期、传输可靠性、协议摇树零运行时、值级脱敏、本地零依赖起步形态、测试与验证方法（oracle/契约）。
