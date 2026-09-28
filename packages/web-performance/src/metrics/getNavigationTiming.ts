import type { IMetrics, IPerformanceNavigationTiming, IReportHandler } from '../types'
import { isPerformanceSupported, isPerformanceObserverSupported } from '../utils/isSupported'
import { metricsName } from '../constants'
import type MetricsStore from '../lib/store'
import observe from '../lib/observe'
import { roundByFour, validNumber } from '../utils'

const resolveNavigationTiming = (
  entry: PerformanceNavigationTiming | undefined | null,
  resolve: (v: IPerformanceNavigationTiming) => void
): void => {
  // 非浏览器环境（node/jsdom）没有 navigation 条目且 performance.timing 为 undefined：
  // 跳过而非崩溃——监控引擎不允许产生 unhandled rejection（CI 0/1 事故修复）
  if (!entry) {
    resolve(undefined as unknown as IPerformanceNavigationTiming)
    return
  }
  const {
    domainLookupStart,
    domainLookupEnd,
    connectStart,
    connectEnd,
    secureConnectionStart,
    requestStart,
    responseStart,
    responseEnd,
    domInteractive,
    domContentLoadedEventStart,
    domContentLoadedEventEnd,
    loadEventStart,
    fetchStart,
  } = entry

  resolve({
    dnsLookup: roundByFour(domainLookupEnd - domainLookupStart),
    initialConnection: roundByFour(connectEnd - connectStart),
    ssl: secureConnectionStart ? roundByFour(connectEnd - secureConnectionStart) : 0,
    ttfb: roundByFour(responseStart - requestStart),
    contentDownload: roundByFour(responseEnd - responseStart),
    domParse: roundByFour(domInteractive - responseEnd),
    deferExecuteDuration: roundByFour(domContentLoadedEventStart - domInteractive),
    domContentLoadedCallback: roundByFour(domContentLoadedEventEnd - domContentLoadedEventStart),
    resourceLoad: roundByFour(loadEventStart - domContentLoadedEventEnd),
    domReady: roundByFour(domContentLoadedEventEnd - fetchStart),
    pageLoad: roundByFour(loadEventStart - fetchStart),
  })
}

const getNavigationTiming = (): Promise<IPerformanceNavigationTiming> | undefined => {
  if (!isPerformanceSupported()) {
    console.warn('browser do not support performance')
    return
  }

  return new Promise((resolve) => {
    if (
      isPerformanceObserverSupported() &&
      PerformanceObserver.supportedEntryTypes?.includes('navigation')
    ) {
      const poRef: { current: PerformanceObserver | undefined } = { current: undefined }
      const entryHandler = (entry: PerformanceEntry) => {
        if (entry.entryType === 'navigation') {
          poRef.current?.disconnect()
          resolveNavigationTiming(entry as PerformanceNavigationTiming, resolve)
        }
      }
      poRef.current = observe('navigation', entryHandler)
    } else {
      const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
      const navigation =
        entries.length > 0
          ? entries[0]
          : ((performance as any).timing as PerformanceNavigationTiming | undefined)
      resolveNavigationTiming(navigation, resolve)
    }
  })
}

export const initNavigationTiming = (
  store: MetricsStore,
  report: IReportHandler,
  immediately = true
): void => {
  getNavigationTiming()
    ?.then((navigationTiming) => {
      // 环境不支持 navigation 时序：跳过采集，不产生假数据
      if (!navigationTiming) return
      const metrics = { name: metricsName.NT, value: navigationTiming } as IMetrics
      if (validNumber(Object?.values(metrics.value))) {
        store.set(metricsName.NT, metrics)
        if (immediately) {
          report(metrics)
        }
      }
    })
    .catch(() => {
      /* 环境不支持：静默降级，监控自身不允许产生 unhandled rejection */
    })
}
