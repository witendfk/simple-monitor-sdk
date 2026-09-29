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
面包屑、批量批量上报（5s/10 条）+ gzip + 离线重放 + 卸载 sendBeacon。

## 框架适配

```ts
// Vue
import { MonitorVue } from '@simple-monitor/web'
app.use(MonitorVue)

// React
import { ErrorBoundary } from '@simple-monitor/web'
<ErrorBoundary fallback={<div>出错了</div>}><App /></ErrorBoundary>
```

## 本地演示（30 秒完整链路）

```bash
pnpm demo:full      # 起服务端(:3000) + demo 页(:5180)
# 打开 http://localhost:5190 看板查看数据
```
