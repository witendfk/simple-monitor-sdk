/**
 * Simple Monitor SDK - Web Integration Bundle
 *
 * 面向业务的聚合入口：把 browser 采集、web-performance、
 * Vue/React 适配统一暴露成一个 init()。
 * 业务方只需 `import { init, log } from '@simple-monitor/web'`。
 *
 * M1（ADR-3 统一拦截层）：门面把默认 client 的事件总线适配成 IEventSource
 * 注入 WebVitals——性能引擎订阅请求/路由数据而不再自行劫持 xhr/fetch/history，
 * 全页面只有 browser 一层补丁（独立使用 web-performance 时仍可自带 proxy）。
 */
import type { InitOptions, PerformanceReportData } from '@simple-monitor/types'
import { EventTypes } from '@simple-monitor/types'
import type { IEventSource } from '@simple-monitor/web-performance'
import { logger, getGlobal } from '@simple-monitor/utils'
import { getDefaultMonitorClient } from '@simple-monitor/core'
import { init as initBrowser } from '@simple-monitor/browser'
import { WebVitals } from '@simple-monitor/web-performance'

// 转出手动 API 与类型
export { log } from '@simple-monitor/browser'
// 框架专属 API（API 导出模式）：业务方 import 后接入框架，init 无法代劳
export { MonitorVue } from '@simple-monitor/vue'
export { ErrorBoundary, errorBoundaryReport } from '@simple-monitor/react'
export type { InitOptions } from '@simple-monitor/types'

const _global = getGlobal<any>()

// 防重复初始化标记位：HMR / StrictMode 下 init 可能被多次调用
const INIT_FLAG = '__Monitor__init__'

/**
 * 把 web-performance 的 IReportData 转成 core transport 的 PerformanceReportData。
 * data 可能是单个 IMetrics { name, value } 或批量 IMetricsObj { [name]: IMetrics }。
 * 性能数据走 core transport（统一 sendBeacon 卸载兜底），eventType:performance 走 trackDsn、不去重。
 */
function toPerformanceReport(reportData: unknown): PerformanceReportData | null {
  const data = (reportData as { data?: unknown } | null)?.data
  if (!data || typeof data !== 'object') return null
  const metrics: Record<string, unknown> = {}
  const d = data as Record<string, unknown>
  if ('name' in d && 'value' in d) {
    // 单个 IMetrics
    metrics[String(d.name)] = d.value
  } else {
    // IMetricsObj：{ [name]: { name, value } }
    for (const [key, val] of Object.entries(d)) {
      const m = val as { value?: unknown } | undefined
      metrics[key] = m && typeof m === 'object' && 'value' in m ? m.value : val
    }
  }
  return { eventType: 'performance', metrics }
}

/** 把默认 client 的事件总线适配成性能引擎的事件源（只订阅，不打补丁） */
function createEventSourceFromClient(): IEventSource {
  const client = getDefaultMonitorClient()
  return {
    onRequest(complete: (url: string) => void): void {
      const relay = (data: { url?: string }): void => {
        if (data && typeof data.url === 'string' && data.url) complete(data.url)
      }
      client.registry.subscribe({ type: EventTypes.XHR, id: 'web-perf.ccp-xhr', callback: relay })
      client.registry.subscribe({
        type: EventTypes.FETCH,
        id: 'web-perf.ccp-fetch',
        callback: relay,
      })
    },
    onRoute(cb: () => void): void {
      client.registry.subscribe({
        type: EventTypes.HISTORY,
        id: 'web-perf.ccp-route',
        callback: () => cb(),
      })
    },
  }
}

/**
 * 初始化 Web 监控。
 *
 * - 幂等：已初始化过则告警并跳过，避免重复打补丁。
 * - browser 采集（错误/HTTP/面包屑）+ web-performance（性能）+ vue/react 适配统一在此编排。
 * - init 失败（缺 dsn/apikey）时短路：不装载采集器、不启用性能采集。
 *
 * @param options dsn / apikey 必填；performance（默认开）控制性能采集
 * @returns 是否成功启动
 */
export function init(options: InitOptions = {}): boolean {
  if (_global[INIT_FLAG]) {
    logger.warn('Simple Monitor 已初始化，请勿重复调用 init()')
    return true
  }

  const client = getDefaultMonitorClient()
  if (!initBrowser(options, client)) return false

  // 性能采集（配置驱动，默认开；performance:false 关闭）
  if (options.performance !== false) {
    if (typeof window !== 'undefined') {
      new WebVitals({
        immediately: false,
        eventSource: createEventSourceFromClient(),
        reportCallback: (reportData) => {
          const perf = toPerformanceReport(reportData)
          if (perf) client.send(perf)
        },
        resourceThreshold: options.resourceThreshold,
        resourceTopN: options.resourceTopN,
      })
    }
  }

  _global[INIT_FLAG] = true
  return true
}
