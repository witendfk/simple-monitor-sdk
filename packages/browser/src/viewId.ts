/**
 * viewId 解析（M3）：SPA 路由视图标识。
 *
 * - hash 路由（#/xxx）取 hash 内路径，history 路由取 pathname；
 * - 经 getRealPath 归一化（纯数字段 → {param}），同模板路由聚合为一个视图。
 */
import { getRealPath } from '@simple-monitor/core'

export function viewIdFromUrl(url: string): string {
  try {
    const u = new URL(url, window.location.href)
    const hashPath = u.hash.startsWith('#/') ? u.hash.slice(1) : ''
    return getRealPath(hashPath ? `${u.origin}${hashPath}` : u.pathname)
  } catch {
    return url
  }
}

export function currentViewId(): string {
  if (typeof window === 'undefined' || !window.location) return ''
  return viewIdFromUrl(window.location.href)
}
