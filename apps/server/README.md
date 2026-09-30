# @simple-monitor/server

监控服务端（总纲 §六）：接收 SDK 上报 → 队列削峰 → 清洗/归一化 → 存储 → 查询 API。

## 快速开始（零依赖，内存实现）

```bash
pnpm --filter @simple-monitor/server dev
# 服务起在 :3000（队列/存储/限流全部内存实现，重启即失）
```

SDK 侧指向它：

```ts
init({ dsn: 'http://localhost:3000/report/batch', apikey: 'demo-key' })
```

查询（`/api/**` 需带 `x-api-key` 头，值为注册的 apikey）：

```bash
curl -H 'x-api-key: demo-key' 'http://localhost:3000/api/overview?sinceMinutes=60'
curl -H 'x-api-key: demo-key' 'http://localhost:3000/api/errors?limit=10'
curl -H 'x-api-key: demo-key' 'http://localhost:3000/api/errors/:fingerprint'
curl -H 'x-api-key: demo-key' 'http://localhost:3000/api/performance?metric=largest-contentful-paint&sinceMinutes=1440'
```

## 基础设施形态（Redis Stream + ClickHouse）

```bash
docker compose up -d          # 起 redis + clickhouse（建表/物化视图自动初始化）
PROJECTS_JSON='[{"apikey":"demo-key","name":"demo","rateLimitPerMin":1000}]' \
REDIS_URL=redis://localhost:6379 \
CLICKHOUSE_URL=http://localhost:8123 \
pnpm --filter @simple-monitor/server start   # 先 pnpm build
```

压测（M4 验收 5k events/s）：

```bash
k6 run -e TARGET=http://localhost:3000 -e RATE=5000 apps/server/k6/report.js
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/report/batch` | SDK 上报（协议 v1 信封），204；400 校验失败 / 403 apikey 未注册 / 429 限流 |
| GET | `/api/overview?sinceMinutes=60` | 概览：事件数、错误数、会话数、Top 错误 |
| GET | `/api/errors?limit=50` | 错误分组（服务端指纹 = type+message+首帧位置） |
| GET | `/api/errors/:fingerprint` | 组详情（完整样本：堆栈/面包屑） |
| GET | `/api/performance?metric=X&sinceMinutes=1440` | 指标分位 P50/P75/P95 |
| POST | `/api/sourcemaps` | SourceMap 工件上传（apikey 取 `x-api-key` 头） |
| GET/POST/DELETE | `/api/alert-rules`、`/api/alert-fires` | 告警规则 CRUD + 触发记录 |

`/api/**` 全部经 `x-api-key` 头校验并按 apikey 过滤查询。**当前使用的仍是浏览器 SDK 中公开的接入 key**，因此这不是独立的看板登录或管理授权；持有该 key 的人可以调用同项目的查询、告警规则和 SourceMap 上传 API。默认 `demo-key` 仅供本地演示，不能作为公网服务的管理凭证。

## 当前形态边界（如实声明）

- **告警 webhook 双道 SSRF 防护**：创建时静态判定（net.BlockList 覆盖私网/保留/环回/ULA/链路本地/NAT64 网段，IPv4-mapped 与尾点变体已覆盖）；发送前 DNS 解析复核 + 重定向逐跳复核（`redirect: 'manual'`，上限 3 跳）。已知边界：解析与连接之间的 TOCTOU 窗口仍在（彻底方案需连接级 socket 拦截）。`WEBHOOK_ALLOW_PRIVATE=1` 仅用于本地演示。
- **Redis 消费循环有监管重启**：consumeLoop 任意终止都会在同一受控循环内退避重启（连续崩溃回归测试锁定）；真实 Redis/ClickHouse 故障联调仍待 docker 环境验收。
- **重复消费未做去重**：at-least-once 语义下重试/重投/崩溃恢复会产生重复计数（errorId 已透传入库，去重方案待落地）。
- **sourcemap 上传受全局 256KB body 上限限制**：真实项目的 map（常为 MB 级）会被 413 拒绝，仅玩具级 map 可上传（服务端需为 `/api/sourcemaps` 单独放开 parser 上限，见总纲 §3.7）。

完整的工程质量评估、风险优先级和验收条件见 [开发总纲 §3.8](../../开发总纲.md)。在公开 key 的管理权限分离完成前，不应将当前形态作为公网多项目服务部署。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `REDIS_URL` | —（内存队列） | 启用 Redis Stream 削峰 + pending 重投 + 死信 |
| `CLICKHOUSE_URL` | —（内存存储） | 启用 ClickHouse 明细存储 + 物化视图聚合 |
| `PROJECTS_JSON` | demo-key | 项目注册表 `[{"apikey","name","rateLimitPerMin"}]` |
| `WEBHOOK_ALLOW_PRIVATE` | false | 置 `1` 放开 webhook 私网限制（仅本地演示） |
| `ALERT_CHECK_INTERVAL_MS` | 300000 | 告警评估周期 |

## 设计要点（详见 开发总纲.md §六）

- 接入层只入队不写库：上报洪峰不能拖垮 HTTP 响应，否则 SDK 侧重试雪崩；
- at-least-once：先处理后确认，失败重试 3 次 → 死信流；重复消费的去重未实现（见「当前形态边界」）；
- 错误指纹两层分工：SDK message 级（流量防刷屏）/ 服务端含首帧位置（分析精度）；
- 存储选型 ClickHouse：监控是"海量写 + 聚合查"的 OLAP 负载，物化视图拿写入换查询。
