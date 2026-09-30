# demo-app — SDK 接入演示应用（订单管理台）

一个**像真实 web 应用**的接入示例：订单管理台（统计卡 / 订单表格 / 新建订单 / 支付 / 取消 / 详情路由）。
`@simple-monitor/web` 以真实项目的方式接入——入口只有 `src/integrate.ts` 一处，业务代码零 SDK API，
监控数据全部来自真实业务操作。

## 运行

```bash
pnpm demo        # 单独起演示页（:5180）
pnpm demo:full   # 起服务端(:3000) + 演示页(:5180)，完整链路
```

- 演示页通过 vite alias 直接引入 `packages/*/src` 源码，改 SDK 代码即时生效；
- SDK dsn 为相对路径 `/report/batch`，经 vite 代理转发到 `DEMO_TARGET`（默认 `http://localhost:3000`）。

## 故障故事线（演示的核心）

页面右上角「故障注入」开关模拟真实应用的线上故障，开启后：

| 故障 | 业务表现 | SDK 采集 |
|---|---|---|
| 支付接口 500 | 点「支付」弹 toast「支付失败」，失败率统计卡变红 | `FETCH_ERROR`（HTTP 5xx） |
| 订单列表混入脏数据 | 表格渲染中断、缺行（`amount.toFixed` TypeError） | `JAVASCRIPT_ERROR` |
| 商品横幅图 404 | 顶部横幅裂图 | `RESOURCE_ERROR` |

操作路径（下单 → 支付 → 路由切详情）进入面包屑；打开 `apps/dashboard` 看板可见错误趋势尖峰、
Top 错误、详情页符号化堆栈 + 面包屑时间线——即总纲 §6.4 的「30 秒演示链路」完整闭环。

## 能力覆盖映射

| SDK 能力 | 触发来源 |
|---|---|
| JS 异常 | 脏数据行渲染 TypeError |
| HTTP 错误 | 支付接口 500 |
| 资源加载错误 | 横幅图 404 |
| Web Vitals / NT / 慢资源 | 页面加载自然上报 |
| 路由 viewId / 面包屑 | 列表 ↔ 详情 hash 路由 |
| 手动埋点（参考） | `integrate.ts` 注释示意（业务代码默认零手动埋点） |

## 与 examples/verify 的关系

本目录是**面向人的接入演示**（`demo:full` 链路入口）；发布产物的**机器验证**（装 tarball + 冒烟断言）
不属于本目录职责——产物验证流程见 `PUBLISH.md`。
