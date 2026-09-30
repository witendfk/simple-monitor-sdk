# 快速开始

## 安装

```bash
npm i @simple-monitor/web
```

## 一个 init 启用全部

```ts
import { init } from '@simple-monitor/web'

init({
  dsn: 'https://your-server/report/batch',  // 服务端见「服务端平台」
  apikey: 'your-key',
})
```

自动启用：JS/Promise/HTTP/资源错误采集、Web Vitals（FP/FCP/LCP/CLS/INP）、
面包屑、批量上报（5s/10 条）+ gzip + 离线缓存重放 + 卸载时尝试 sendBeacon。重放再次失败时当前会丢失缓存信封；服务端公开接入 key 也尚不能作为独立管理凭证，详见 [服务端平台](./server.md)。

## 框架适配

```ts
// Vue（子路径导入，主入口零框架依赖）
import { MonitorVue } from '@simple-monitor/web/vue'
app.use(MonitorVue)

// React
import { ErrorBoundary } from '@simple-monitor/web/react'
<ErrorBoundary fallback={<div>出错了</div>}><App /></ErrorBoundary>
```

## 本地演示（30 秒完整链路）

```bash
pnpm demo:full      # 起服务端(:3000) + demo 页(:5180)
# 打开 http://localhost:5190 看板查看数据
```
