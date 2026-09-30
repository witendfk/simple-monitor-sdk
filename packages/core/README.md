# @simple-monitor/core

Simple Monitor SDK 的核心引擎，框架无关。负责配置绑定、用户行为栈、错误去重（errorId）、数据转换、事件总线与上报通道（XHR / Image / sendBeacon / wx.request）。被 `browser` / `vue` / `react` / `web` 等平台包依赖，业务方通常不直接使用本包。

## 安装

```bash
npm i @simple-monitor/core
```

> 该包通常作为平台包（`@simple-monitor/web` 等）的依赖被间接引入。仅在需要绕过平台适配、自行编排采集时才直接使用。

## 用法

```ts
import { initCore, log, transportData, breadcrumb } from '@simple-monitor/core'
import { Severity } from '@simple-monitor/types'

// 1. 初始化核心运行时（校验 dsn / apikey 必填，绑定全部运行时配置）
initCore({
  dsn: 'https://up.example.com/report',
  apikey: 'your-apikey',
  maxBreadcrumbs: 20,
})

// 2. 手动上报一条业务日志
try {
  doSomething()
} catch (err) {
  log({ message: '处理失败', tag: 'biz', level: Severity.Error, ex: err })
}
```

## API

### `initCore(options: InitOptions = {}): void`

初始化核心运行时。校验 `dsn` / `apikey` 必填后，依次：设静默标志 → 绑定面包屑 → 绑定 logger → 绑定 transportData → 绑定 options。平台包的 `init()` 应调用本函数，避免直接触碰 core 内部。

### 数据上报（`transportData`）

- `transportData` — `TransportData` 单例，对外暴露：
  - `send(data)` — 核心上报入口。组装信封（authInfo + breadcrumb + deviceInfo）→ `beforePost` 生成 errorId / 去重 → 选通道发送；页面卸载时自动切 `sendBeacon`（紧急同步，防丢）。
  - `bindOptions(options)` — 绑定 dsn / apikey / trackDsn / trackKey / useImgUpload 及各 hook。
  - `isSdkTransportUrl(targetUrl)` — 判断某 URL 是否为 SDK 自身上报地址（避免监听到自己的请求）。
  - `getAuthInfo()` / `getApikey()` / `getTrackKey()` / `getTrackerId()` — 读取认证信息。
  - `getTransportData(data)` — 组装完整的 `TransportDataType` 信封。
  - `getRecord()` / `getDeviceInfo()` — 录屏片段与设备信息。
  - 字段：`queue` / `errorDsn` / `trackDsn` / `apikey` / `trackKey` / `useImgUpload` 及各 hook（`beforeDataReport` / `configReportXhr` / `configReportUrl` / `configReportWxRequest` / `backTrackerId`）。
- `TransportData` — 类本身（一般用 `transportData` 单例即可）。

### 用户行为栈（`breadcrumb`）

- `breadcrumb` — `Breadcrumb` 单例：
  - `push(data)` / `immediatePush(data)` — 入栈一条行为。
  - `getStack()` — 获取当前行为栈。
  - `clear()` — 清空。
  - `shift()` — 移除最早一条。
  - `getCategory(type)` — 由 `BreadCrumbTypes` 取分类。
  - `bindOptions(options)` — 绑定 `maxBreadcrumbs` / `beforePushBreadcrumb`。
- `Breadcrumb` — 类本身。

### 错误去重（`errorId`）

- `createErrorId(data, apikey)` — 基于错误指纹生成 errorId（用于去重，受 `maxDuplicateCount` 控制）。
- `getRealPath(url)` — 规范化 URL（去 hash / 去查询），用于指纹稳定。
- `hashCode(str)` — 字符串哈希。
- `getFlutterRealOrigin(url)` / `getFlutterRealPath(url)` / `getRealPageOrigin(url)` / `removeHashPath(url)` — Flutter / 页面路径相关规范化辅助。

### 数据转换（`transformData`）

- `httpTransform(data)` — 把 `MonitorHttp` 转成统一的 `ReportDataType`。
- `resourceTransform(target)` — 资源加载失败目标转 `ReportDataType`。
- `handleConsole(data)` — 处理拦截到的 console 调用。

### 配置管理（`options`）

- `options` — `Options` 单例，持有 traceId / 过滤正则 / 节流 / 各 hook / 微信小程序钩子等运行时配置。
- `Options` — 类本身，`bindOptions(options)` 逐项校验并绑定。
- `setTraceId(httpUrl, callback)` — 满足条件时生成 traceId 并经回调注入请求头。
- `initOptions(paramOptions?)` — 初始化入口（设静默标志 → 面包屑 → logger → transportData → options）。

### 事件总线（`subscribe`）

- `subscribeEvent(handler)` — 订阅一个事件处理器（返回是否订阅成功，受静默开关控制）。
- `triggerHandlers(type, data)` — 触发某类事件的所有处理器。
- `ReplaceHandler` / `ReplaceCallback` — 处理器结构与回调类型。

### 全局支持（`global`）

- `_support` — 全局 `MonitorSupport` 对象（logger / breadcrumb / transportData / replaceFlag / deviceInfo / options）。
- `getGlobalMonitorSupport()` — 获取 / 创建全局支持对象。
- `getGlobal` — 透传 `@simple-monitor/utils` 的同名函数。
- `silentConsoleScope(callback)` — 在静默 console 作用域内执行回调。
- `setSilentFlag(paramOptions)` — 根据 `silentXxx` 配置写入各采集器标志位。

### 手动上报（`external`）

- `log({ message, tag?, level?, ex?, type? })` — 手动上报日志。Error 对象会自动提取堆栈；同时写入用户行为栈。

### 日志（`logger`）

- `Logger` — 日志接口类型（`@simple-monitor/utils` 提供实现）。

## 数据流

```
原始事件 → transformData 转换 → transportData.send
  → beforePost（生成 errorId / 去重 / 钩子）
  → 通道选择（XHR / Image / 卸载时 sendBeacon）
  → Queue → 服务端
```

## 依赖

- `@simple-monitor/types` · `@simple-monitor/shared` · `@simple-monitor/utils`

## 可靠性与隐私边界（2026-09-30 复审，同日修复后更新）

- 离场使用 `sendBeacon` 尽力发送，不能保证送达；IndexedDB 缓存重放已改为**确认服务端 2xx 才删除**对应信封，网络失败/非 2xx 保留待下轮（`src/idbCache.ts` drain/deleteById、`src/batchSender.ts` replay）——堆积由上限 50 条（丢最老）与 3 天过期兜底，不会无限增长。
- 错误事件的 `message`/`name`/堆栈帧 URL/HTTP 文本已在信封出口统一脱敏（先 mask 后按协议上限截断，`src/envelope.ts`）。

开放风险与验收条件见 [开发总纲 §3.8](../../开发总纲.md)。
