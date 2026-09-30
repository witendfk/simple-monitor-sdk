# 服务端平台

详见 [apps/server/README](https://github.com/witendfk/simple-monitor-sdk/blob/feature/apps/server/README.md)。

- 接入：`POST /report/batch`（协议校验 / apikey 鉴权 / 限流 / 入队 204）
- 队列：Redis Stream（consumer group + pending 重投 + 死信）或内存
- 存储：ClickHouse（MergeTree TTL 30 天 + 错误组/性能分位物化视图）或内存
- SourceMap：`bin/sourcemap-cli` 上传 → 错误详情自动符号化

`/api/**` 当前以与浏览器 SDK 相同的公开接入 key 校验，并按 key 过滤查询；该 key 也能调用告警和 SourceMap 管理接口，尚无独立管理授权。Webhook 目前只做 URL 字面值过滤，私网 IPv6、域名解析及重定向等 SSRF 路径仍未封闭。公网多项目部署前需先处理这两项风险；重复消费无去重、Redis 连续故障恢复和 SourceMap 256KB 上限等边界见 [服务端 README](https://github.com/witendfk/simple-monitor-sdk/blob/feature/apps/server/README.md)，优先级与验收条件见 [开发总纲 §3.8](https://github.com/witendfk/simple-monitor-sdk/blob/feature/开发总纲.md)。
