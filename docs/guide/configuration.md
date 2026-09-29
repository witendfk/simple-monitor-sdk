# 配置矩阵

> 配置项 = 承诺：下表所有项均有实现与测试背书（历史教训：声明未实现是最贵债务）。

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dsn` | string | 必填 | 上报地址（`POST dsn/batch`，协议 v1 信封） |
| `apikey` | string | 必填 | 项目标识（服务端鉴权 + 指纹隔离） |
| `trackDsn` | string | 回落 dsn | 性能数据独立通道 |
| `release` / `env` | string | — | 发版/环境标识（发版对比维度） |
| `sampleRate` | number | 1 | 性能采样率（错误始终 100%） |
| `performance` | boolean | true | 性能采集开关 |
| `enablePrivacyMask` | boolean | true | 隐私脱敏（手机号/身份证/卡号/凭证/JWT） |
| `enableTraceId` + `includeHttpUrlTraceIdRegExp` | boolean/RegExp | false | traceparent 注入（W3C Trace Context） |
| `filterXhrUrlRegExp` | RegExp | — | 敏感接口排除（完全不监控） |
| `maxBreadcrumbs` | number | 10 | 面包屑容量 |
| `maxDuplicateCount` | number | 2 | 同错误上报次数上限 |
| `silentXxx` 系列 | boolean | false | 静默开关（含 silentResource 独立资源错误开关） |
| `throttleDelayTime` | number | 200 | 点击采集节流 ms |
| `disabled` | boolean | false | 停止上报（采集照常） |

## 高级钩子

`beforeDataReport` / `configReportUrl` / `configReportXhr` / `backTrackerId` /
`beforePushBreadcrumb` / `onRouteChange` —— 见 `@simple-monitor/types` 的 `InitOptions`。

## 手动 API

```ts
log({ message: '支付失败', tag: 'payment', level: Severity.Critical, ex: err })
```
