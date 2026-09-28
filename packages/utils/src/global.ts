import { variableTypeDetection } from './is'

declare const wx: any
declare const global: any
declare const process: any
declare const App: any

/**
 * 获取当前环境的全局对象
 * 支持浏览器、微信小程序、Node.js 等环境
 * @returns 全局对象
 */
export function getGlobal<T>(): T {
  if (typeof window !== 'undefined') {
    return window as unknown as T
  }
  if (typeof wx !== 'undefined') {
    return wx as unknown as T
  }
  if (typeof global !== 'undefined') {
    return global as unknown as T
  }
  return {} as T
}

/**
 * 获取全局对象（Window 类型）
 */
export const _global = getGlobal<Window>()

/**
 * 环境检测
 */
export const isNodeEnv = variableTypeDetection.isProcess(
  typeof process !== 'undefined' ? process : 0
)

export const isWxMiniEnv =
  variableTypeDetection.isObject(typeof wx !== 'undefined' ? wx : 0) &&
  variableTypeDetection.isFunction(typeof App !== 'undefined' ? App : 0)

/**
 * 浏览器环境判定：拥有 document 的 window 才是浏览器环境。
 * 不用 toString 标签（isWindow）——跨 realm / 环境代理（vitest jsdom、iframe）
 * 的 window 标签可能是 '[object global]'，语义化判定更稳。
 */
export const isBrowserEnv = typeof window !== 'undefined' && !!window.document

/**
 * 检测是否支持 history API
 */
export function supportsHistory(): boolean {
  const chrome = (_global as any).chrome
  const isChromePackagedApp = chrome && chrome.app && chrome.app.runtime
  const hasHistoryApi =
    'history' in _global && !!_global.history.pushState && !!_global.history.replaceState

  return !isChromePackagedApp && hasHistoryApi
}

/** 框架无关地检测 history API 可用性（浏览器打包 App 内 history 被禁用的场景） */
