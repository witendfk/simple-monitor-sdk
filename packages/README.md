# Simple Monitor SDK — 包矩阵

自研采集层的完整前端监控：SDK（错误 + 性能 + 行为 + 可靠传输 + 合规）+ 服务端 + 自建看板。产品需求见 [docs/PRD.md](../docs/PRD.md)，技术文档体系见 [docs/](../docs/)。

| 包 | 职责 |
|---|---|
| [`@simple-monitor/protocol`](./protocol/) | 协议 v1 单一事实来源：zod schema + LIMITS 截断常量，SDK 与服务端共用 |
| [`@simple-monitor/types`](./types/) | 公共类型定义 |
| [`@simple-monitor/shared`](./shared/) | 共享常量与默认配置（规划并入 protocol） |
| [`@simple-monitor/utils`](./utils/) | 基础设施：AOP 替换、微任务队列、脱敏 mask、堆栈解析 |
| [`@simple-monitor/core`](./core/) | 引擎：MonitorClient 类、事件总线、面包屑、信封组装、采样、批量传输、IndexedDB 缓存 |
| [`@simple-monitor/browser`](./browser/) | 唯一 instrumentation 层：xhr/fetch/history/console 补丁、错误捕获、行为采集、白屏检测 |
| [`@simple-monitor/web-performance`](./web-performance/) | 纯性能计算引擎：自研 Web Vitals（oracle 对齐官方库）+ NT/RT/FPS/LongTask |
| [`@simple-monitor/web`](./web/) | 门面：一个 init 全量接入（主入口零框架依赖；react/vue 走子路径） |
| [`@simple-monitor/vue`](./vue/) / [`@simple-monitor/react`](./react/) | 框架适配（errorHandler / ErrorBoundary + 组件名解析） |

平台范围：Web（含 SPA，SSR 安全）；小程序支持规划中——原生 wx 打底 + uniapp 适配层两步走（ADR-10，见 [docs/PRD.md](../docs/PRD.md) §3.10）；Flutter 不支持。遗留 wx 类型与降级通道仍在代码中挂账，见 [docs/tasks/CURRENT.md](../docs/tasks/CURRENT.md) 4.2。

各包 API 细节见各子包 README；SDK 行为规格见 [docs/SPEC.md](../docs/SPEC.md)。
