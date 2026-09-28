/**
 * 浏览器能力守卫（SSR/node 安全）：一律先判 window 存在再取属性——
 * 这些守卫在每个指标的 init 入口调用，非浏览器环境必须返回 false 而非崩溃。
 */
export const isPerformanceSupported = (): boolean =>
  typeof window !== 'undefined' &&
  !!window.performance?.getEntriesByType &&
  !!window.performance.mark

export const isPerformanceObserverSupported = (): boolean =>
  typeof window !== 'undefined' && !!window.PerformanceObserver

export const isNavigatorSupported = (): boolean =>
  typeof window !== 'undefined' && !!window.navigator
