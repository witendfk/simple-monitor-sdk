/**
 * SDK 全局承载（M1 瘦身，ADR-1）
 *
 * 旧实现把 breadcrumb / transportData / options / replaceFlag 等 N 个单例全挂在
 * window.__Monitor__ 上——多实例互串、SSR 崩溃、测试无法隔离的总根源。
 *
 * 现在全局对象只承载一件事：默认 MonitorClient 实例（跨 bundle 实例共享用）。
 * 所有模块状态随 client 实例走，见 client.ts。
 */

import { MonitorClient } from './client'

// 兼容旧导出：实现已移至 utils（消除 global → client → breadcrumb → global 循环依赖）
export { silentConsoleScope } from '@simple-monitor/utils'

/** 全局唯一承载点：仅存默认 client，不再存散装单例 */
const GLOBAL_KEY = '__Monitor__'

interface MonitorCarrier {
  defaultClient?: MonitorClient
}

function getGlobalThis(): any {
  return typeof globalThis !== 'undefined' ? globalThis : {}
}

function getCarrier(): MonitorCarrier {
  const carrier = getGlobalThis()
  if (!carrier[GLOBAL_KEY]) {
    carrier[GLOBAL_KEY] = {} as MonitorCarrier
  }
  return carrier[GLOBAL_KEY]
}

/** 取/建默认 client（跨 bundle 实例，如 ESM+CJS 混载，共享同一个） */
export function getDefaultMonitorClient(): MonitorClient {
  const carrier = getCarrier()
  if (!carrier.defaultClient) {
    carrier.defaultClient = new MonitorClient()
  }
  return carrier.defaultClient
}

/** 测试/重置用：丢弃默认 client（下次取用重新创建） */
export function resetDefaultMonitorClient(): void {
  getCarrier().defaultClient = undefined
}
