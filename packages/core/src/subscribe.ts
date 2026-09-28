/**
 * Subscribe Module - 事件总线（M1 类化，ADR-1）
 *
 * 注册表由 MonitorClient 实例持有，不再依赖模块级状态/全局 flag。
 *
 * 幂等语义（修复旧实现「匿名函数名退化 → 按 type 误去重」问题，总纲 §3.3）：
 *  - 去重键 = `${type}#${id}`，**只认显式 id**；
 *  - 不传 id 的订阅（无论匿名还是具名）各自独立注册，永不互斥——
 *    生产采集器一律显式传 id（browser/handleEvents 均已带 `browser.*` id）；
 *  - 想去重就给 id，不给就去重不了——语义显式化，杜绝函数名推断的隐性行为。
 */

import type { EventTypes } from '@simple-monitor/types'
import { nativeTryCatch } from '@simple-monitor/utils'

/**
 * Event callback function type
 * Receives event data as parameter
 */
export type ReplaceCallback = (data: any) => void

/**
 * Event handler interface
 * Combines event type with its callback
 */
export interface ReplaceHandler {
  /** Event type to listen to */
  type: EventTypes | string
  /** Callback function to execute when event is triggered */
  callback: ReplaceCallback
  /**
   * 显式订阅标识（幂等去重键）。同 type 同 id 重复注册被拒；
   * 不传 id 则每次都注册（多 handler 场景的默认行为）。
   */
  id?: string
}

/**
 * 订阅注册表：type → callbacks 数组（同 type 允许多 handler，错误隔离执行）
 */
export class HandlerRegistry {
  private handlers: Record<string, ReplaceCallback[]> = {}
  private registered = new Set<string>()

  /**
   * 订阅事件；重复（同 type 同 id）返回 false，不重复注册
   */
  subscribe(handler: ReplaceHandler): boolean {
    if (handler.id !== undefined) {
      const dedupeKey = `${handler.type}#${handler.id}`
      if (this.registered.has(dedupeKey)) {
        return false
      }
      this.registered.add(dedupeKey)
    }
    if (!this.handlers[handler.type]) {
      this.handlers[handler.type] = []
    }
    this.handlers[handler.type].push(handler.callback)
    return true
  }

  /**
   * 触发某类型的全部 handler，单个回调异常被隔离（nativeTryCatch），不波及其他回调与宿主
   */
  trigger(type: EventTypes | string, data: any): void {
    const callbacks = this.handlers[type]
    if (!callbacks || callbacks.length === 0) {
      return
    }
    callbacks.forEach((callback) => {
      nativeTryCatch(
        () => {
          callback(data)
        },
        (_error: Error) => {
          // 单个采集回调异常静默隔离：监控代码 bug 不允许波及宿主业务
        }
      )
    })
  }

  /** 清空注册表（destroy / 测试重置用） */
  clear(): void {
    this.handlers = {}
    this.registered.clear()
  }
}
