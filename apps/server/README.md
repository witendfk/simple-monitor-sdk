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

查询：

```bash
curl 'http://localhost:3000/api/overview?sinceMinutes=60'
curl 'http://localhost:3000/api/errors?limit=10'
curl 'http://localhost:3000/api/errors/:fingerprint'
curl 'http://localhost:3000/api/performance?metric=largest-contentful-paint&sinceMinutes=1440'
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
| GET | `/health` | 存活 + 队列统计 |

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `REDIS_URL` | —（内存队列） | 启用 Redis Stream 削峰 + pending 重投 + 死信 |
| `CLICKHOUSE_URL` | —（内存存储） | 启用 ClickHouse 明细存储 + 物化视图聚合 |
| `PROJECTS_JSON` | demo-key | 项目注册表 `[{"apikey","name","rateLimitPerMin"}]` |

## 设计要点（详见 开发总纲.md §六）

- 接入层只入队不写库：上报洪峰不能拖垮 HTTP 响应，否则 SDK 侧重试雪崩；
- at-least-once：先处理后确认，失败重试 3 次 → 死信流；重复由服务端指纹去重消化；
- 错误指纹两层分工：SDK message 级（流量防刷屏）/ 服务端含首帧位置（分析精度）；
- 存储选型 ClickHouse：监控是"海量写 + 聚合查"的 OLAP 负载，物化视图拿写入换查询。
