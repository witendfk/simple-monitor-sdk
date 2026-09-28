import { EventTypes, SilentEventTypes, WxAppEvents, WxPageEvents } from '@simple-monitor/types'

/**
 * 静默开关表（M1 类化，ADR-1）
 *
 * 旧实现把 silent 标志写进 utils 的模块级 replaceFlag 全局 map——多实例互串、无法隔离测试。
 * 现在标志随 MonitorClient 实例走：`client.setSilent(type, on)` / `client.isSilent(type)`。
 *
 * 资源错误使用独立开关（修复旧版 silentError 连带静默资源错误问题，总纲 §3.4）。
 */
export class SilentFlags {
  private map = new Map<string, boolean>()

  /** 设置某类事件是否静默 */
  set(type: string, silent: boolean): void {
    this.map.set(type, silent)
  }

  /** 查询某类事件是否被静默 */
  isSilent(type: string): boolean {
    return this.map.get(type) === true
  }

  /** 按初始化配置批量设置（InitOptions.silentXxx） */
  bindOptions(options: InitOptionsLike = {}): void {
    this.set(EventTypes.XHR, !!options.silentXhr)
    this.set(EventTypes.FETCH, !!options.silentFetch)
    this.set(EventTypes.CONSOLE, !!options.silentConsole)
    this.set(EventTypes.DOM, !!options.silentDom)
    this.set(EventTypes.HISTORY, !!options.silentHistory)
    this.set(EventTypes.ERROR, !!options.silentError)
    this.set(EventTypes.RESOURCE_ERROR_EVENT, !!options.silentResource)
    this.set(EventTypes.HASHCHANGE, !!options.silentHashchange)
    this.set(EventTypes.UNHANDLEDREJECTION, !!options.silentUnhandledrejection)
    this.set(EventTypes.VUE, !!options.silentVue)
    // wx（预留，采集包未实装）
    this.set(WxAppEvents.AppOnError, !!options.silentWxOnError)
    this.set(WxAppEvents.AppOnPageNotFound, !!options.silentWxOnPageNotFound)
    this.set(WxPageEvents.PageOnShareAppMessage, !!options.silentWxOnShareAppMessage)
  }

  clear(): void {
    this.map.clear()
  }
}

/** 避免与 types 循环依赖的最小形状 */
interface InitOptionsLike extends SilentEventTypes {
  silentResource?: boolean
  silentWxOnError?: boolean
  silentWxOnPageNotFound?: boolean
  silentWxOnShareAppMessage?: boolean
}
