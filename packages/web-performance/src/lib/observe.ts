import type { PerformanceEntryHandler } from '../types'

/**
 * PerformanceObserver 封装：
 *  - 先检测 supportedEntryTypes（避免不支持的类型抛错）
 *  - buffered:true 捕获脚本加载前已产生的条目
 *  - 单条目处理异常就地隔离（监控不伤宿主：坏条目不允许以 uncaught error
 *    形式打进宿主页面——事件总线有 nativeTryCatch，PO 回调是同一条纪律的入口）
 */
const observe = (
  type: string,
  callback: PerformanceEntryHandler,
  options?: PerformanceObserverInit & { durationThreshold?: number }
): PerformanceObserver | undefined => {
  if (PerformanceObserver.supportedEntryTypes?.includes(type)) {
    const po = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        try {
          callback(entry)
        } catch {
          /* 单条目处理异常：静默隔离，不影响后续条目与宿主 */
        }
      })
    })
    po.observe({ buffered: true, ...options, type } as PerformanceObserverInit & {
      durationThreshold?: number
    })
    return po
  }
}

export default observe
