/**
 * Simple Monitor SDK - Core Module（M1 门面）
 *
 * 面向两类消费者：
 *  1. 平台包（browser/vue/react/web）：优先持有 MonitorClient 实例传递；
 *     不传时回落默认 client（getDefaultMonitorClient）。
 *  2. 兼容层：`breadcrumb` / `transportData` / `options` / `subscribeEvent` /
 *     `triggerHandlers` / `initCore` / `setSilentFlag` 指向默认 client 的对应成员，
 *     保持旧包名出口稳定（测试与旧接入代码可平滑迁移）。
 */

import type { InitOptions } from '@simple-monitor/types'
import { getDefaultMonitorClient } from './global'
import { log } from './external'

// ---- 数据转换（纯函数） ----
export { httpTransform, resourceTransform, handleConsole, CROSS_ORIGIN_THRESHOLD } from './transformData'

// ---- 核心类（ADR-1：状态随实例走） ----
export { MonitorClient } from './client'
export { HandlerRegistry } from './subscribe'
export type { ReplaceHandler, ReplaceCallback } from './subscribe'
export { SilentFlags } from './flags'
export { Breadcrumb } from './breadcrumb'
export { Options, createTraceParent } from './options'
export { TransportData } from './transportData'
export type { TransportDeps } from './transportData'

// ---- 纯函数工具 ----
export { createErrorId, clearDedup, getRealPath, getRealPageOrigin, hashCode } from './errorId'

// ---- 全局与日志 ----
export { getDefaultMonitorClient, resetDefaultMonitorClient, silentConsoleScope } from './global'
export { logger } from '@simple-monitor/utils'

// ---- 手动上报 ----
export { log, logToClient } from './external'

// ============ 默认 client 兼容出口（单例语义收敛到这里） ============

const defaultClient = getDefaultMonitorClient()

/** 默认 client 的面包屑（兼容出口；新代码请持有 client 实例） */
export const breadcrumb = defaultClient.breadcrumb

/** 默认 client 的上报引擎（兼容出口） */
export const transportData = defaultClient.transport

/** 默认 client 的配置（兼容出口） */
export const options = defaultClient.options

/**
 * 订阅默认 client 的事件总线（兼容出口）。
 * 新代码请使用 `client.registry.subscribe({ type, callback, id })`（显式 id 幂等）。
 */
export function subscribeEvent(handler: import('./subscribe').ReplaceHandler): boolean {
  return defaultClient.registry.subscribe(handler)
}

/** 触发默认 client 总线上的某类事件（兼容出口） */
export function triggerHandlers(type: string, data: any): void {
  defaultClient.registry.trigger(type, data)
}

/**
 * 初始化默认 client（兼容出口）。
 * 返回 false 表示校验失败（缺 dsn/apikey），调用方应跳过后续采集器装载。
 */
export function initCore(options: InitOptions = {}): boolean {
  return defaultClient.init(options)
}
