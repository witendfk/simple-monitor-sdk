/**
 * Simple Monitor SDK - Web Performance（独立引擎，对齐 encode 架构）
 *
 * 决策（路线图 3.1）：
 *  - 采 INP，不采 FID（FID 已于 2024-03-12 被 INP 取代为 Core Web Vital）
 *  - 自研 PerformanceObserver 采集 + buffered flag + getFirstHiddenTime 处理页面隐藏
 *  - 独立引擎：经 reportCallback 把数据交还业务，不耦合 core transportData
 *  - 评分用 Chrome 对数正态分布模型
 *  - RT（Resource Timing）：定位慢资源文件，单文件 duration >= 阈值即上报
 */
import type { IConfig, IWebVitals, IMetricsObj, IEventSource } from './types'
export type { IEventSource } from './types'
import generateUniqueID from './utils/generateUniqueID'
import { afterLoad, beforeUnload, unload } from './utils'
import { onHidden } from './lib/onHidden'
import createReporter from './lib/createReporter'
import MetricsStore from './lib/store'
import { measure } from './lib/measureCustomMetrics'
import { setMark, clearMark, getMark, hasMark } from './lib/markHandler'
import { initNavigationTiming } from './metrics/getNavigationTiming'
import { initDeviceInfo } from './metrics/getDeviceInfo'
import { initNetworkInfo } from './metrics/getNetworkInfo'
import { initPageInfo } from './metrics/getPageInfo'
import { initFP } from './metrics/getFP'
import { initFCP } from './metrics/getFCP'
import { initINP } from './metrics/getINP'
import { initLCP } from './metrics/getLCP'
import { initFPS } from './metrics/getFPS'
import { initCLS } from './metrics/getCLS'
import { initCCP } from './metrics/getCCP'
import { initResourceTiming } from './metrics/getResourceTiming'
import { initLongTask } from './metrics/getLongTask'

// 模块级句柄（getCurrentMetrics/setEndMark 等实例 API 需要访问最近一次构造的实例状态）。
// 多实例时后者覆盖前者——构造期即覆盖，各实例回调闭包各自持有引用不受影响；
// 彻底实例化留待 M2（总纲 ADR-1 收尾项）。
let metricsStore: MetricsStore
let reporter: ReturnType<typeof createReporter>

class WebVitals implements IWebVitals {
  immediately: boolean = false

  constructor(config: IConfig) {
    if (typeof window === 'undefined') {
      // SSR 安全：性能采集依赖浏览器 API，服务端渲染环境直接跳过
      return
    }
    const {
      appId,
      version,
      reportCallback,
      immediately = false,
      isCustomEvent = false,
      logFpsCount = 5,
      apiConfig = {},
      hashHistory = true,
      excludeRemotePath = [],
      maxWaitCCPDuration = 30 * 1000,
      scoreConfig = {},
      resourceThreshold = 300,
      resourceTopN = 10,
      eventSource,
    } = config

    this.immediately = immediately

    const sessionId = generateUniqueID()
    window.__monitor_sessionId__ = sessionId
    reporter = createReporter(sessionId, appId as string, version as string, reportCallback)
    metricsStore = new MetricsStore()

    initPageInfo(metricsStore, reporter, immediately)
    initNetworkInfo(metricsStore, reporter, immediately)
    initDeviceInfo(metricsStore, reporter, immediately)
    initCLS(metricsStore, reporter, immediately, scoreConfig)
    initLCP(metricsStore, reporter, immediately, scoreConfig)
    initCCP(
      metricsStore,
      reporter,
      isCustomEvent,
      apiConfig,
      hashHistory,
      excludeRemotePath,
      maxWaitCCPDuration,
      immediately,
      scoreConfig,
      eventSource as IEventSource | undefined
    )
    // 资源耗时：hidden/unload 采集慢资源 Top-N（自身注册监听，阈值可配）
    initResourceTiming(metricsStore, reporter, resourceThreshold, resourceTopN)
    // 长任务：hidden 时终值上报（定位主线程阻塞源，M3）
    initLongTask(metricsStore, reporter, immediately)

    // FP/FCP 注册时机：晚于 load 注入（动态加载/运营脚本）时 pageshow 已错过，
    // 退化为 once 监听会永久缺失——readyState 已 complete 则立即采集（M3 修复）
    const initPaint = (): void => {
      initFP(metricsStore, reporter, immediately, scoreConfig)
      initFCP(metricsStore, reporter, immediately, scoreConfig)
    }
    if (document.readyState === 'complete') {
      setTimeout(initPaint)
    } else {
      addEventListener(isCustomEvent ? 'custom-contentful-paint' : 'pageshow', initPaint, {
        once: true,
        capture: true,
      })
    }

    afterLoad(() => {
      initNavigationTiming(metricsStore, reporter, immediately)
      initINP(metricsStore, reporter, immediately, scoreConfig)
      initFPS(metricsStore, reporter, logFpsCount as number, immediately)
    })

    // immediately=false 时，页面隐藏 / 卸载时批量上报。
    // 卸载上报必须同步（urgent=true）：requestIdleCallback 在页面销毁后不执行。
    ;[beforeUnload, unload, onHidden].forEach((fn) => {
      fn(() => {
        const metrics = this.getCurrentMetrics()
        if (Object.keys(metrics).length > 0 && !immediately) {
          reporter(metrics, true)
        }
      })
    })
  }

  getCurrentMetrics(): IMetricsObj {
    return metricsStore.getValues()
  }

  private static dispatchCustomEvent(): void {
    const event = document.createEvent('Events')
    event.initEvent('custom-contentful-paint', false, true)
    document.dispatchEvent(event)
  }

  setStartMark(markName: string): void {
    setMark(`${markName}_start`)
  }

  setEndMark(markName: string): void {
    setMark(`${markName}_end`)

    if (hasMark(`${markName}_start`)) {
      const value = measure(`${markName}Metrics`, markName)
      this.clearMark(markName)
      const metrics = { name: `${markName}Metrics`, value }
      metricsStore.set(`${markName}Metrics`, metrics)
      if (this.immediately) {
        reporter(metrics)
      }
    } else {
      const value = getMark(`${markName}_end`)?.startTime
      this.clearMark(markName)
      const metrics = { name: `${markName}Metrics`, value }
      metricsStore.set(`${markName}Metrics`, metrics)
      if (this.immediately) {
        reporter(metrics)
      }
    }
  }

  clearMark(markName: string): void {
    clearMark(`${markName}_start`)
    clearMark(`${markName}_end`)
  }

  customContentfulPaint(): void {
    setTimeout(() => {
      WebVitals.dispatchCustomEvent()
    })
  }
}

export { WebVitals }
