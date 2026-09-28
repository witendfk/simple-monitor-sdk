import { onHidden } from './onHidden'

/**
 * 页面首次隐藏时间戳：页面加载过程中若已隐藏，相关指标（FP/FCP/LCP/INP）不应记录。
 *
 * M1 修复（总纲 §3.3）：
 *  - 旧实现每次调用都注册一对新监听器（LCP/INP/CCP 各处反复调用 → 监听器堆积）；
 *    现在 bindOnce 只注册一次，全部调用方共享同一份状态；
 *  - 「页面首次隐藏」是页面级事实，单例语义正确（与 ADR-1 不冲突）；
 *  - SSR 安全：无 document 时惰性返回 Infinity，不在模块顶层触碰 DOM。
 */
let firstHiddenTime: number =
  typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 0 : Infinity
let bound = false

function bindOnce(): void {
  if (bound || typeof document === 'undefined') return
  bound = true
  onHidden((e: Event) => {
    const ts = typeof e.timeStamp === 'number' && e.timeStamp > 0 ? e.timeStamp : 0
    firstHiddenTime = Math.min(firstHiddenTime, ts)
  }, true)
}

const getFirstHiddenTime = () => {
  bindOnce()
  return {
    get timeStamp(): number {
      return firstHiddenTime
    },
  }
}

export default getFirstHiddenTime
