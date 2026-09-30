/**
 * SDK 接入唯一入口 —— 真实项目里就是应用启动文件（main.ts / _app.tsx）中的一段。
 *
 * 接入点只有这里；业务代码（app.ts）不出现任何 SDK API。
 * 被采集的内容与接入参数的关系：
 *   - JS 异常 / Promise 拒绝 / 资源加载错误：自动采集（无需配置）
 *   - HTTP 请求：xhr/fetch 自动包装（5xx 与失败上报，2xx 进面包屑）
 *   - 路由切换：history 包装 → viewId / 面包屑
 *   - 性能指标：WebVitals 实例（独立消费 @simple-monitor/web-performance）
 */
import { init } from '@simple-monitor/web'
import { WebVitals } from '@simple-monitor/web-performance'

init({
  dsn: '/report/batch', // 同源相对路径：经 vite 代理 / DEMO_TARGET 指向任意服务端
  apikey: 'demo-key',
  release: 'v0.1.0-demo',
  enableTraceId: true, // W3C traceparent 注入（链路串联演示）
})

// 性能引擎（Web Vitals + 导航耗时 + 慢资源），数据走业务自己的 reportCallback，
// 演示环境仅打印；生产环境在此接入你的上报器。
new WebVitals({
  appId: 'acme-orders',
  immediately: false,
  reportCallback: (data) => {
    console.debug('[web-vitals]', data.data?.name ?? Object.keys(data.data ?? {}))
  },
})
