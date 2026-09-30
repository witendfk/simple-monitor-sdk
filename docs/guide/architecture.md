# 架构与 ADR

九包 monorepo 单向依赖：types/protocol（契约）→ utils → core（引擎）→ browser/web-performance（端侧）+ vue/react（适配）→ web（门面）。

服务端（apps/server）：接入（协议校验/限流）→ 队列（Redis Stream/内存）→ 清洗归一化 → 存储（ClickHouse/内存）→ 查询 API → 看板。

完整内容见仓库 [开发总纲.md](https://github.com/witendfk/simple-monitor-sdk/blob/feature/开发总纲.md)（ADR-1~7：多实例类化 / 契约先行 / 统一拦截层 / 存储选型 / 自建看板 / oracle 一致性 / W3C Trace Context）。

## 关键取舍（面试深挖区）

- **错误指纹两层分工**：SDK message 级（流量防刷屏）/ 服务端含首帧位置（分析精度）
- **CLS session-window / INP 聚合+P98**：oracle 一致性测试对比官方库（同条目流，偏差断言进 CI）
- **队列 at-least-once**：先处理后确认，死信兜底；重复消费的去重当前未实现（errorId 已入库，待补）。SDK 离线重放目前会先清空缓存、失败不回写，因此端到端尚不能保证 at-least-once（总纲 §3.8）。
- **异步纪律**：fire-and-forget 链全部就地消化，监控不向宿主抛 unhandled rejection
