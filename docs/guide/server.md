# 服务端平台

详见 [apps/server/README](https://github.com/witendfk/simple-monitor-sdk/blob/feature/apps/server/README.md)。

- 接入：`POST /report/batch`（协议校验 / apikey 鉴权 / 限流 / 入队 204）
- 队列：Redis Stream（consumer group + pending 重投 + 死信）或内存
- 存储：ClickHouse（MergeTree TTL 30 天 + 错误组/性能分位物化视图）或内存
- SourceMap：`bin/sourcemap-cli` 上传 → 错误详情自动符号化
