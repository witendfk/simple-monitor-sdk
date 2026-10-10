# 当前任务与进度（tasks/CURRENT）

> 最后更新: 2026-10-10（文档评审批次：告警/SourceMap 补 ⚠️ 重启不持久、PRD 新增数据保留条目、SPEC LIMITS 拆规格/现状两列、docker 联调环境提级为 M7.5 P1 前置、手动 API/过滤/consent 定档「M8 前小切片」。前情：四件套重组，总纲退役归档为 [LEDGER.md](./LEDGER.md)）
>
> 状态说明：`[ ]` 待开始 ｜ `[~]` 进行中 ｜ `[x]` 已完成（含验收记录）｜ `[-]` 搁置/取消。**完成任何条目：勾销 + 回填实际结果；新问题一律先写验收条件再动手**（SOP 见 [ARCHITECTURE §7.3](../ARCHITECTURE.md)）。

## 1. 当前状态快照

| 维度         | 状态                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| 里程碑       | M0-M7 基础能力已落地，§3.3 记录对码评审的未闭合缺口；体积预算脚本尚未接入 CI；下一站 M7.5 存储与权限架构；手动 API/错误过滤/consent 已定档「M8 前小切片」 |
| 测试         | 最近记录为 239 tests；CI 当前执行 typecheck×3 / lint / build / test / conformance，尚无 size 步骤        |
| 需求基线     | [PRD](../PRD.md) v1.0.0；Web 核心产品为当前交付线，AI 与小程序不阻塞首发                                 |
| 开放 P0      | 权限分离（§3.2，既有）+ 行为/API 隐私旁路与服务端脱敏缺口（§3.3，本次评审核实）                          |
| npm 发布     | 搁置（注册被反滥用拦截，找他人账号；流程就绪见 PUBLISH.md）                                              |
| 基础设施验证 | 真实 Redis/ClickHouse 联调、k6 压测实测待 docker 环境（已提级为 M7.5 P1 前置，见 §3.1）                  |

## 2. 已完成里程碑（M0-M7，详情见 [LEDGER.md](./LEDGER.md) 附录 B）

| 里程碑                  | 交付要点                                                                                               | 验收                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------- |
| [x] M0 契约与决策       | ADR 定稿；protocol 包（zod + LIMITS）；trackDsn 回落 + 录屏死代码清理                                  | 100 测试全绿                |
| [x] M1 SDK 核心重构     | ADR-1 类化 + ADR-3 统一拦截层；隐私脱敏三入口；TraceId；22 处问题勾销                                  | 122 测试                    |
| [x] M2 上报可靠性引擎   | BatchSender（5s/10条）+ gzip + IndexedDB 重放 + 指数退避 + 通道状态机 + 采样                           | 159 测试                    |
| [x] M3 性能引擎对齐     | ADR-6 oracle 进 CI（真实输入驱动）；viewId 贯穿；LongTask 累加器；SSR 加固                             | conformance 绿              |
| [x] M4 服务端接入与存储 | NestJS 接入 + Redis Stream + ClickHouse/Memory 双实现 + 查询 API                                       | 186 测试；⚠️ 真实联调待     |
| [x] M5 聚合/查询/看板   | SourceMap 符号化闭环 + release 元数据记录 + 自建看板 + tarball 发布验证；发版过滤/徽标仍待 M8          | 30 秒演示链路通             |
| [x] M6 告警/发布        | 告警引擎 + 规则管理视图 + PUBLISH.md；早期文档站与短篇 guide 已移除，对外指南待产品落地后补            | 199 测试；npm 实测搁置      |
| [x] M7 行为域埋点       | 协议 v1.1（kind behavior/api）+ 采集升格 + 按域采样 + 独立信封组 + 体积预算脚本 + 白屏 + LongTask 分档 | 236 测试；CI 体积门禁待接入 |

维护批次：2026-09-30 三轮审查（§3.7 全清零、SSRF 双道、离线重放 2xx 确认删除、监管循环、gzip 中间件）；2026-10-09 d45f919 补 resource_kind 拆分 + PV 来源归因（UTM）。

## 3. 进行中 / 下一步

### 3.1 [ ] M7.5 生产级存储架构（ADR-4 落地，设计见 [ARCHITECTURE §3.2](../ARCHITECTURE.md)）

- [ ] **P1 前置：联调环境立起**：docker-compose 起真实 Redis / ClickHouse / Postgres（原 §4.3「M4 遗留验证」提级——P1/P2 的验收条件均依赖此环境，环境未立不动 P1）。验收：三容器健康检查通过，server 以 `NODE_STORAGE=infra` 起动后全链路冒烟绿
- [ ] **P1 Postgres 元数据**：projects 双密钥 / users / members / issues 状态机（fingerprint UNIQUE + first_seen/last_seen/event_count）/ alert_rules+history / releases / sourcemap_artifacts 全量 DDL，替换内存实现。验收：docker-compose 起库后全链路回归绿；CH 写入与 PG Issue 更新任一步失败时可重放或对账，不永久错计
- [ ] **P2 CH 按 kind 分表**：error_events（含 resource_kind）/ perf_events / behavior_events / api_events 四表 + 各自物化视图，替代单宽表；须完整保留行为事件名/属性/PV 来源与成功 API 请求明细，不能沿用现有宽表只存通用列的缺口。验收：k6 冒烟 + 相同数据在 Memory/CH 的明细与聚合查询一致
- [ ] **P3 权限分离**（= 下文 3.2，P0 消零）
- [ ] **P4 gateway 加固**：先在 SPEC 定义稳定事件 ID、作用域与重试窗口，再实现幂等和令牌桶限流；MemoryStorage 的误去重先按 §3.3 修复。验收：同信封重放不重复计数；去重标记、CH 写入和 PG 更新之间任一步失败后可安全重试；限流语义单测
- [ ] **P5 看板对齐**：4 分组页面（概览健康度英雄卡 + 5 域总结网格；错误 9 分类卡片 + 排行表 + 维度 tabs）。验收：对照 PRD §6 逐视图出数

### 3.2 [ ] 独立切片：服务端权限分离（既有 P0）

**问题**：浏览器 SDK 必须携带的公开 apikey 同时放行 `/api/**` 查询、告警管理、SourceMap 上传——持有 key 即可读取项目错误、改告警规则、上传 SourceMap（`apps/server/src/auth/api-key.guard.ts:23`）。

**范围**：分离公开上报标识与服务端读写身份（管理凭证只留服务端，users 表归 M7.5 P1）；Guard 分层；dashboard 使用服务端会话登录，不把管理密钥注入 Vite 构建产物；文档与部署说明同步。

**验收条件**：分离后公开 key 无法访问查询/告警/SourceMap API（401/403 用例锁定）；管理凭证全功能回归；README 边界声明更新。不依赖 M7-M10，npm 发布前必须完成。

### 3.3 [ ] PRD 对码评审修复清单（2026-10-10）

按产品目标记录实现偏差；优先级表示对隐私、数据可信度和宿主稳定性的影响，不表示当前要立即对外部署。以下每项修复后按 [ARCHITECTURE §7.3](../ARCHITECTURE.md) 复审并同步 PRD/SPEC 状态。

- [ ] **P0 信封隐私出口与服务端二次防线**：`packages/core/src/behaviorEnvelope.ts:40` 原样装载事件；`packages/browser/src/behaviors.ts:80` 的 PV URL、`packages/browser/src/behaviors.ts:141` 的声明式 props、`packages/browser/src/handleEvents.ts:160` 的成功 API URL 可直接外发；`packages/core/src/envelope.ts:189` 的性能 detail 也未深层脱敏；`apps/server/src/ingest/normalize.ts:136` 未二次脱敏。统一在主信封和行为/API 信封出口对嵌套字符串 mask + 截断，并在 ingest 独立兜底。验收：手机号、JWT、带 token 的 URL 分别经 `track`、`data-track-props`、PV、成功 API、性能 detail 上报，网络载荷、IndexedDB 和两种存储中均无原值；服务端直接接收含敏感值的合法信封也不落原值
- [ ] **P1 行为通道离场发送**：`packages/core/src/behavior.ts:101` 的 `flushLeaving()` 为空，独立发送器没有离场生命周期；`packages/browser/src/behaviors.ts:114` 的 pagehide dwell 入队后仍等待定时器，hidden 后延迟 pagehide 还可能把后台时间算作停留。接通 hidden/pagehide 与 visible/pageshow 状态切换，只在可见时结算 dwell，结算后同步 flush。验收：页面运行不足 5 秒即关闭，PV、track、成功 API 与达到阈值的 dwell 各进入 beacon 一次；hidden 多秒后 pagehide 不新增后台停留；恢复可见后继续发送且不重复结算
- [ ] **P1 CH 行为/API 明细完整性**：`apps/server/src/storage/clickhouse.storage.ts:13` 的 EventRow 与 `docker/clickhouse/init.sql:3` 无 behavior/api 明细列，`recentBehaviors()` 只读通用列。可先补当前宽表列，再随 M7.5 P2 分表；M8/M9 查询依赖此数据。验收：相同 PV 来源、track 属性及 API method/url/status/duration 写入两种存储后，明细查询一致
- [ ] **P1 beacon 大信封拆批**：`packages/core/src/batchSender.ts:184` 每段都从事件数组起点截取，后续事件丢失且首段重复；当前按 UTF-16 长度而非 UTF-8 字节判 64KB；部分分片失败时会缓存整包，重放已被接受的分片。按实际事件偏移与字节预算拆分，逐片记录结果。验收：多个不同事件组成 >64KB 信封，全部 beacon 合并后每个事件恰好出现一次，单片字节数不超上限；模拟前片成功后片失败，仅失败片入缓存
- [ ] **P1 Memory 错误去重误抑制**：`apps/server/src/storage/memory.storage.ts:14` 的永久 Set 把 SDK 允许的第二次同类错误和跨会话错误都当重试；淘汰旧事件时 Set 不回收。与 M7.5 P4 的稳定事件 ID/窗口设计合并修复。验收：两次真实发生及跨会话同类错误都计数；同一事件重放只计一次；超过 5 万事件后去重状态有界
- [ ] **P1 有界解析与采样**：`apps/server/src/main.ts:43` 的 gzip 只限制压缩输入，`gunzipSync` 无解压输出上限；`packages/browser/src/replace.ts:268` 对无 Content-Length 的文本响应 `clone().text()` 全量读入。分别限制解压后字节数、流式有界读取响应样本。验收：高压缩比请求返回 413；无长度头的大型/持续文本响应不会让服务端或宿主内存随正文持续增长，业务响应仍可正常读取
- [ ] **P2 行为预算与声明式 LIMITS**：`packages/core/src/behavior.ts:86` 把成功 API 算入 500 条行为采集预算；`packages/browser/src/behaviors.ts:141` 的声明式属性绕过键数/体积限制。按 PRD 区分会话采集预算（满额丢新）与待发送缓冲上限（满额丢旧），成功 API 只受独立采样与发送缓冲上限约束。验收：成功 API 不挤占行为预算；第 501 条行为按预算丢弃，缓冲区超限保留最新事件；超 32 键/2KB 的 `data-track-props` 按契约处理且不整包拒绝

## 4. 待办 Backlog（勾销制）

### 4.1 DoD 缺口（2026-10-10 对码核实，PRD 标 🚧）

- [ ] 手动 API：`captureException` / `captureMessage` / `setUser` / `setTag`（已定档「M8 前小切片」，PRD §8 已映射）
- [ ] 标准错误过滤：`ignoreErrors` / `allowUrls` / `denyUrls`（同上）
- [ ] consent mode：未同意只采集错误不采集行为（同上）

### 4.2 P2 挂账（按域概括；修复时逐条到源码定位，按 SOP 先写验收条件）

- **死代码/配置契约**：silentHashchange 零消费；silentWxOnUnhandledRejection/silentMiniRoute 声明无绑定；信封 referrer/viewport 未接线；beaconPost/xhrPost 生产零调用；core/logger.ts 整文件与 utils 15+ 死导出；shared constants 键名与 session.ts 字面量两套并存；ERROR_TYPE_RE 两份正则不同双零引用
- **健壮性边界**：validateOption NaN 穿透（sampleRate/限流阈值）；extractErrorStack gecko 空栈分支；XHR readystatechange 监听堆积；INP Map 滞留 DOM 引用；bfcache pageshow 未 once；CCP completeQueue 无界 / isIncludeArr 不计重数 / lazy 图片永不产出；用户正则 g 标志 lastIndex 污染；Vue 非 Error 脏上报；SVG 资源误报 JS 错误（待确认）；React 无 silent 开关；collectDeviceInfo 单层 try；domReplace 节流异常隔离；自定义打点信封通道静默丢失；logger 默认 enabled=false 使 error 级全静默；面包屑 push 每次 sort O(n log n)
- **服务端**：二次截断只做一半（stack 32KB/面包屑 512B/httpBody）；RedisRateLimiter INCR/EXPIRE 非原子；error_spike 基线含观测窗口；MemoryQueue 缓冲无界；affectedSessions 乱序虚增；PROJECTS_JSON 解析失败静默回落 demo；CH 写入/查询时区格式不一致（待确认）
- **看板/示例**：「10s 自动刷新」对 errors tab 不成立；AlertsView 表单弱校验；看板无 ErrorBoundary；看板零测试覆盖

### 4.3 遗留验证与工程项

- [ ] `pnpm size` 接入 CI 构建后步骤，超预算阻断合并（M7 遗留）
- [ ] `pnpm lint:ci` 当前 167 warnings，恰达 167 上限；按批消减存量并同步下调 `--max-warnings`，验收为下一批 warning 数与上限均低于 167
- [ ] k6 压测实测：接入层 5k events/s 单机稳定（脚本见 `apps/server/k6/report.js`）
- [ ] 真实 IndexedDB 断网→恢复 e2e（M2 遗留）
- [ ] SDK 自身 long task 开销度量（M2 遗留）
- [ ] page_dwell 在真实浏览器的 hidden/pagehide 端到端复核（随 §3.3 行为离场发送修复）
- [ ] provenance 发布签名（PUBLISH.md：CI 发布 job 加 `NPM_CONFIG_PROVENANCE` + `id-token: write`）
- [ ] 浏览器矩阵 CI、codecov、playground
- [ ] 产品落地后补面向使用者的接入指南；npm 真实发布 + 陌生人 15 分钟接入实测（[-] 搁置：注册被拦，流程就绪等账号）
- [ ] rrweb 回放实装（[-] 预留延后：协议占位保留，待回放需求明确）

## 5. 路线图（M8-M12）

| 里程碑                                                                      | 范围                                                                                                                                                                                                                                                           | 验收标准                                                                                                                                         |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [ ] **M8 看板横切与访问域**（3 周）                                         | 时间范围 + 维度过滤横切全部查询端点（SQL 全参数化）；issue 趋势 + 受影响会话数（uniqExact）；`/api/visits`、`/api/requests`；看板访问/API 视图 + 全局时间/过滤栏。先确定采样率传递方式，必要时做协议加性扩展                                                   | 维度过滤防注入审计；UV 按 trackerId、会话数按 sessionId；成功量经采样率校正且显示估算口径；PV/UV 与成功率视图出数                                |
| [ ] **M9 埋点分析域**（3 周）                                               | 事件浏览器（事件名聚合/最近样本/属性 Top-N 近似）；漏斗（`windowFunnel`：事件序列 + 窗口期）；N 日留存（`retention()`，按 trackerId）；看板三视图                                                                                                              | 漏斗/留存以 demo 数据出图；10 万行明细查询 <1s                                                                                                   |
| [ ] **M10 AI 诊断报告**（2 周，仅依赖 M5 资产，可并行穿插）                 | ADR-9：provider 抽象（OpenAI 兼容 env 可配）+ 上下文组装 + POST diagnose / GET diagnosis + IDiagnosisStore（内存先行）+ 看板诊断区 + 护栏（缓存/限流/截断/注入隔离/无 key 501）                                                                                | demo 错误一键出诊断且 evidence 可核对到堆栈帧；输出 schema 契约测试；项目级启用和外发字段最小化经隐私审查；无 key 全链路回归不破；注入用例不越权 |
| [ ] **M11 小程序原生包**（~3 周，待排期，可与 M8 并行；权限分离 P0 不让位） | ADR-10：`packages/wx`——错误（App.onError 等）/ HTTP（覆写 wx.request）/ PV + scene 来源归因 / 停留时长 / 曝光 / track / 传输（App.onHide 离场 flush + wx storage 重放）/ wx.getPerformance 映射；遗留 wx 通道与类型转正，P2 挂账中 wx 静默开关条目随本切片处理 | demo 小程序全事件类型出数；契约测试两端跑；接入文档含 request 合法域名配置与基础库门槛                                                           |
| [ ] **M12 uniapp 适配层**（~2 周，依赖 M11）                                | ADR-10：`packages/uniapp`——Vue 插件（app.use）+ 页面级 mixin + 框架错误钩子；仅小程序编译目标，H5 目标引导用 web SDK                                                                                                                                           | uniapp demo（mp-weixin）全链路出数；与原生包行为语义一致（同一协议契约测试）                                                                     |

裁剪序与不可砍下限见 [DESIGN §3](../DESIGN.md)。

## 6. 候选池（未圈优先级，不进路线图承诺）

对标沉淀的服务端可取清单（SDK 侧借鉴已随 M7 全部落地）：通知渠道 provider 抽象（钉钉/企微/Slack/邮件）、HLL 影响用户估算、metric_minute 分钟预聚合、SSE realtime、sourcemap 独立 api-key、维度过滤 SQL 构建器、9 分类错误码体系。圈定优先级后修订 [PRD §7](../PRD.md) 候选演进池再立项。
