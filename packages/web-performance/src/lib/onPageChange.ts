import type { OnPageChangeCallback } from '../types'
import { proxyHistory } from './proxyHandler'

const unifiedHref = (href: string): string => {
  try {
    return decodeURIComponent(href?.replace(`${location?.protocol}//${location?.host}`, ''))
  } catch {
    return href || ''
  }
}

/** 初始地址（SSR 安全：无 location 时为空串） */
let lastHref = typeof location !== 'undefined' ? unifiedHref(location.href) : ''

/**
 * 监听 SPA 路由变化：hashchange / popstate / history.pushState|replaceState。
 *
 * M1 修复（总纲 §3.3）：
 *  - lastHref 旧为 const 永不更新 → pushState 去重条件恒真；现每次触发后更新；
 *  - 注册发生在函数调用时（惰性），模块 import 无副作用。
 */
export const onPageChange = (cb: OnPageChangeCallback): void => {
  if (typeof window === 'undefined') return
  window.addEventListener('hashchange', function (e) {
    cb(e)
  })
  window.addEventListener('popstate', function (e) {
    cb(e)
  })
  proxyHistory((...args) => {
    const currentHref = unifiedHref(args?.[2])
    if (lastHref !== currentHref) {
      lastHref = currentHref
      cb()
    }
  })
}
