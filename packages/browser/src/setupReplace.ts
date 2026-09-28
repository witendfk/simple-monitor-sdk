/**
 * 采集编排（setupReplace）
 *
 * 把「采集器绑定（replace.ts）」和「处理器订阅（handleEvents.ts）」装配到指定 client。
 * 顺序固定：先订阅（注册回调），再装采集器（addEventListener / replaceOld），
 * 否则先触发的事件没有回调可分发。
 *
 * 幂等：装载次数由 browser/init 的 client.initialized 守卫控制——
 * 同一 client 只会走到这里一次（修复旧版「重复 init 双份监听器」问题）。
 */

import type { MonitorClient } from '@simple-monitor/core'
import { collectDeviceInfo } from './deviceInfo'
import { currentViewId } from './viewId'
import {
  listenError,
  listenUnhandledRejection,
  xhrReplace,
  fetchReplace,
  consoleReplace,
  domReplace,
  historyReplace,
} from './replace'
import {
  handleError,
  handleResourceError,
  handleUnhandledRejection,
  handleHttp,
  handleConsoleEvent,
  handleDomEvent,
  handleHistoryEvent,
} from './handleEvents'

/**
 * 为 client 安装全部浏览器采集器。
 */
export function setupReplace(client: MonitorClient): void {
  // 0. 采集设备信息（一次性写入 transport，上报信封复用）；初始化路由视图标识
  client.transport.deviceInfo = collectDeviceInfo()
  client.viewId = currentViewId()

  // 1. 先订阅处理器（注册回调到事件总线）
  handleError(client)
  handleResourceError(client)
  handleUnhandledRejection(client)
  handleHttp(client)
  handleConsoleEvent(client)
  handleDomEvent(client)
  handleHistoryEvent(client)

  // 2. 再绑定原生 API 采集器
  listenError(client)
  listenUnhandledRejection(client)
  xhrReplace(client)
  fetchReplace(client)
  consoleReplace(client)
  domReplace(client)
  historyReplace(client)
}
