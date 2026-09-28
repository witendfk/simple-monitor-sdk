/**
 * CCP（Custom Contentful Paint）—— 自定义内容绘制：页面关键远程 API 完成 + 图片加载完成的时刻。
 * 用于度量「业务可用首屏」时刻，区别于浏览器的 FCP/LCP。
 *
 * M1 修复（总纲 §3.3 / ADR-1 / ADR-3）：
 *  - remoteQueue / completeQueue / isDone / reportLock / firstVisited 全部改为 per-init
 *    闭包状态——旧实现是模块级单例，多 WebVitals 实例互串；
 *  - 可选注入 eventSource（IEventSource）：走 web 门面时由门面把 core 事件总线适配进来，
 *    CCP 订阅请求数据而不再自行劫持 xhr/fetch（消灭与 browser 的双层包装）；
 *    独立使用（不传 source）时保持自有 proxy 兜底；
 *  - 「首次访问」状态随 init 闭包走，路由变化监听经 source 或 onPageChange。
 */
import { proxyFetch, proxyXhr } from '../lib/proxyHandler'
import { onPageChange } from '../lib/onPageChange'
import type { IEventSource } from '../types'
import type MetricsStore from '../lib/store'
import type { IReportHandler, IScoreConfig, IMetrics } from '../types'
import { getApiPath, isIncludeArr, isEqualArr, isExistPath, beforeUnload } from '../utils'
import getPath from '../utils/getPath'
import { isPerformanceSupported } from '../utils/isSupported'
import { metricsName } from '../constants'
import { onHidden } from '../lib/onHidden'
import getFirstHiddenTime from '../lib/getFirstHiddenTime'
import calcScore from '../lib/calculateScore'

/** CCP 派生指标的取值类型：ACT 为时间对象、CCP 为数值 */
type CcpValue = { time: number; remoteApis: string[] } | number

const storeMetrics = (
  name: string,
  value: CcpValue,
  store: MetricsStore,
  scoreConfig?: IScoreConfig
): void => {
  const scoreValue =
    name === metricsName.ACT
      ? (value as { time: number; remoteApis: string[] }).time
      : (value as number)
  const metrics = { name, value, score: calcScore(name, scoreValue, scoreConfig) ?? undefined }
  store.set(name, metrics)
}

export const initCCP = (
  store: MetricsStore,
  report: IReportHandler,
  isCustomEvent: boolean,
  apiConfig: { [prop: string]: string[] },
  hashHistory: boolean,
  excludeRemotePath: string[],
  maxWaitCCPDuration: number,
  immediately: boolean,
  scoreConfig?: IScoreConfig,
  source?: IEventSource
): void => {
  if (typeof window === 'undefined') return

  // ---- per-init 状态（旧：模块级单例） ----
  const remoteQueue = { hasStoreMetrics: false, queue: [] as string[] }
  const completeQueue: string[] = []
  let isDone = false
  let reportLock = true
  /** 是否仍处于「首次访问」：发生首次路由切换后置 false，CCP 仅在首访期间采集 */
  let firstVisited = true

  const beforeHandler = (url: string): void => {
    if (!isPerformanceSupported()) return
    const path = getPath(location, hashHistory)
    if (!firstVisited) return
    const remotePath = getApiPath(url)
    if (isExistPath(excludeRemotePath, remotePath)) return
    if (apiConfig && apiConfig[path]) {
      if (apiConfig[path].some((o) => remotePath === o)) {
        remoteQueue.queue.push(remotePath)
      }
    } else if (!isDone) {
      remoteQueue.queue.push(remotePath)
    }
  }

  const afterHandler = (url: string): void => {
    if (!isPerformanceSupported()) return
    const path = getPath(location, hashHistory)
    if (!firstVisited) return
    const remotePath = getApiPath(url)
    if (isExistPath(excludeRemotePath, remotePath)) return
    completeQueue.push(remotePath)
    const tryStoreACT = (): void => {
      if (!remoteQueue.hasStoreMetrics) {
        remoteQueue.hasStoreMetrics = true
        const now = performance.now()
        if (now < getFirstHiddenTime().timeStamp) {
          storeMetrics(
            metricsName.ACT,
            { time: now, remoteApis: remoteQueue.queue },
            store,
            scoreConfig
          )
          computeCCP()
        }
      }
    }
    if (apiConfig && apiConfig[path]) {
      if (isIncludeArr(remoteQueue.queue, completeQueue)) tryStoreACT()
    } else if (isIncludeArr(remoteQueue.queue, completeQueue) && isDone) {
      tryStoreACT()
    }
  }

  const computeCCP = (): void => {
    setTimeout(() => {
      const images = Array.from(document.querySelectorAll('img')).filter(
        (image) => !image.complete && image.src
      )
      if (images.length > 0) {
        let loadImages = 0
        const finish = (): void => {
          loadImages += 1
          if (loadImages === images.length) {
            storeMetrics(metricsName.CCP, performance.now(), store, scoreConfig)
          }
        }
        images.forEach((image) => {
          image.addEventListener('load', finish)
          image.addEventListener('error', finish)
        })
      } else {
        storeMetrics(metricsName.CCP, performance.now(), store, scoreConfig)
      }
    })
  }

  const reportMetrics = (): void => {
    if (reportLock) {
      const act = store.get(metricsName.ACT)
      const ccp = store.get(metricsName.CCP)

      // urgent=true：CCP 是一次性关键数据，且 reportMetrics 在卸载/隐藏/兜底超时触发，
      // 必须同步送达——走 requestIdleCallback 会在卸载时整批丢失
      if (act && ccp) {
        if (act.value.time < ccp.value) {
          report(act, true)
          report(ccp, true)
        }
      } else if (ccp) {
        report(ccp, true)
      }
      reportLock = false
    }
  }

  // 首屏判定事件（pageshow / 自定义事件）
  const event = isCustomEvent ? 'custom-contentful-paint' : 'pageshow'
  addEventListener(
    event,
    () => {
      if (!firstVisited) return
      isDone = true
      if (isPerformanceSupported()) {
        const now = performance.now()
        if (now < getFirstHiddenTime().timeStamp) {
          if (isEqualArr(remoteQueue.queue, completeQueue) && !remoteQueue.hasStoreMetrics) {
            remoteQueue.hasStoreMetrics = true
            storeMetrics(
              metricsName.ACT,
              { time: performance.now(), remoteApis: remoteQueue.queue },
              store,
              scoreConfig
            )
          }
          computeCCP()
        }
      }
    },
    { once: true, capture: true }
  )

  if (immediately) {
    beforeUnload(() => reportMetrics())
    onHidden(() => reportMetrics(), true)
    // SPA 路由变化：结束首访期并触发上报；优先用注入的事件源（门面已订阅总线，不重复打补丁）
    const bindRoute = (cb: () => void): void => {
      if (source) source.onRoute(cb)
      else onPageChange(cb)
    }
    bindRoute(() => {
      firstVisited = false
      reportMetrics()
    })
    setTimeout(() => reportMetrics(), maxWaitCCPDuration)
  }

  // 请求监听：优先事件源（ADR-3 统一拦截层），独立使用时回退自有 proxy
  if (source) {
    source.onRequest((url) => {
      beforeHandler(url)
      afterHandler(url)
    })
  } else {
    proxyXhr(
      (url) => beforeHandler(url),
      (url) => afterHandler(url)
    )
    proxyFetch(
      (url) => beforeHandler(url),
      (url) => afterHandler(url)
    )
  }
}
