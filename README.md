# Simple Monitor SDK

> 轻量级、模块化的前端监控 SDK（浏览器 + Vue + React）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 简介

Simple Monitor SDK 是一个轻量级、模块化的前端监控方案，提供**错误追踪**、**性能监控**、**用户行为（面包屑）**与**框架错误捕获**。门面包 `@simple-monitor/web` 一个 `init()` 启用全部能力。

### 特性

- **🐛 错误追踪** — JS 异常 / Promise / HTTP（xhr+fetch）/ 资源加载错误，自动捕获 + 去重
- **📊 性能监控** — Web Vitals（FP/FCP/LCP/CLS/INP）+ FPS + 加载瀑布 + **RT 慢资源定位**
- **🔖 用户行为** — 面包屑（HTTP / 点击 / 路由 / console），随错误上报
- **🧩 框架适配** — Vue（Vue2/Vue3 双兼容）/ React（开箱即用 ErrorBoundary）
- **⚡ 卸载可靠** — 页面卸载自动切 `sendBeacon`，不丢数据
- **📦 模块化** — 分层（基础/核心/端侧/门面），可按需引入子包

## 快速开始

### 安装

```bash
npm i @simple-monitor/web
# 或 yarn add / pnpm add @simple-monitor/web
```

### 基础用法（一个 init 启用全部）

```ts
import { init } from '@simple-monitor/web'

init({
  dsn: 'https://up.example.com/report',
  apikey: 'your-apikey',
})
```

自动启用：错误 / HTTP / Promise / 资源采集 + 性能采集 + 卸载 sendBeacon。

### 按需引入（只装你要的，不拉全量）

SDK 分层模块化，可只装需要的子包，不必引入门面：

**只做性能采集**（不拉 vue / react / browser）：

```ts
import { WebVitals } from '@simple-monitor/web-performance'  // 独立引擎，仅依赖 types/utils

new WebVitals({
  reportCallback: (data) => {
    // 性能指标交给你，自己发到服务（卸载务必用 sendBeacon 防丢）
    navigator.sendBeacon('/your-perf-endpoint', JSON.stringify(data))
  },
  resourceThreshold: 300,  // 慢资源阈值 ms
})
```

| 场景 | 装哪个 | 说明 |
|---|---|---|
| 全部能力 | `@simple-monitor/web` | 门面，一个 `init()` |
| 只性能 | `@simple-monitor/web-performance` | 独立引擎，`reportCallback` 自己接 |
| 只错误采集 | `@simple-monitor/browser` | 浏览器 8 采集器 |
| 只框架错误 | `@simple-monitor/vue` / `@simple-monitor/react` | 配合 core |

> 门面 `web` = 方便（全量一个 init）；单独子包 = 按需（体积小、自己编排）。详见各 `packages/*/README.md`。

### 框架错误捕获

```ts
import { MonitorVue, ErrorBoundary } from '@simple-monitor/web'

// Vue（Vue3 / Vue2 通用）
app.use(MonitorVue)

// React
<ErrorBoundary fallback={<div>出错了</div>}>
  <App />
</ErrorBoundary>
```

## 采集的能力

### 错误追踪（自动）

| 类型 | 触发 | 上报 |
|---|---|---|
| JS 异常 | `window.onerror` | `JAVASCRIPT_ERROR` |
| Promise | `unhandledrejection` | `PROMISE_ERROR` |
| HTTP | xhr / fetch 包装 | `FETCH_ERROR`（5xx / status 0；2xx 只进面包屑） |
| 资源 | img/script/link `error` | `RESOURCE_ERROR` |

同错误自动去重（`maxDuplicateCount`，默认 2 次）。SDK 自身上报地址被拦截，不自循环。

### 性能监控（默认开）

| 指标 | 说明 |
|---|---|
| FP / FCP | 首次绘制 / 首次内容绘制 |
| LCP | 最大内容绘制 |
| CLS | 累积布局偏移（session-window 算法，对齐 2021 官方） |
| INP | 交互到下一帧（取代已废弃的 FID） |
| FPS | 帧率 |
| CCP | 自定义首屏（业务可用时刻：关键 API + 图片完成） |
| RT | **慢资源定位**（duration ≥ 阈值 + 阶段拆解 + 跨域处理） |
| NavigationTiming | 加载瀑布（DNS / TCP / SSL / TTFB / DOM） |

性能数据走统一 core transport（`eventType:performance`），卸载靠 sendBeacon。

### 用户行为（面包屑，自动）

HTTP / 点击 / 路由 / console 自动入栈，随错误一起上报，便于还原出错现场。

## 配置选项

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dsn` | `string` | *必需* | 错误上报地址 |
| `apikey` | `string` | — | 错误上报鉴权 key |
| `trackDsn` | `string` | — | 埋点/性能上报地址（性能走此） |
| `performance` | `boolean` | `true` | 性能采集开关 |
| `resourceThreshold` | `number` | `300` | 慢资源判定阈值（ms） |
| `resourceTopN` | `number` | `10` | 慢资源 Top-N |
| `maxBreadcrumbs` | `number` | — | 面包屑最大条数 |
| `maxDuplicateCount` | `number` | `2` | 同错误去重阈值 |
| `silentXxx` | `boolean` | — | 静默各类采集（`silentError`/`silentXhr`/`silentFetch`/`silentConsole`/`silentDom`/`silentHistory`/`silentUnhandledrejection`/`silentHashchange`/`silentVue`） |
| `disabled` | `boolean` | `false` | 完全关闭上报（采集器仍装载） |

完整类型见 `@simple-monitor/types` 的 `InitOptions`。高级 hook（`beforeDataReport`/`configReportXhr`/`backTrackerId` 等）见各子包 README。

## 包结构（分层架构）

```
基础层   types / utils / shared          类型 / 工具 / 共享常量
核心层   core                             transport / breadcrumb / errorId / 事件总线（框架无关）
端侧采集 browser / web-performance       浏览器采集 / 性能采集
         vue / react                     框架错误捕获
门面层   web                              聚合 init（业务入口）
```

各子包说明见 `packages/*/README.md`：

- [`@simple-monitor/web`](./packages/web) — 门面，业务入口
- [`@simple-monitor/browser`](./packages/browser) — 浏览器采集
- [`@simple-monitor/web-performance`](./packages/web-performance) — 性能采集（[架构文档](./packages/web-performance/ARCHITECTURE.md)）
- [`@simple-monitor/vue`](./packages/vue) / [`@simple-monitor/react`](./packages/react) — 框架适配
- [`@simple-monitor/core`](./packages/core) — 核心引擎

## 开发

```bash
pnpm install       # 安装（Node >= 16, pnpm >= 8）
pnpm build         # 构建所有包（ESM + CJS）
pnpm test          # 单元测试（vitest）
pnpm typecheck     # 类型检查
```

> 产品目标、架构决策、问题清单与路线图见 [开发总纲.md](./开发总纲.md)（唯一开发依据文档）。

## License

[MIT](./LICENSE)
