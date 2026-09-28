/**
 * MonitorClient 语义测试（M1 ADR-1：多实例 / 幂等 / 生命周期 / 事件总线）
 */
import { describe, it, expect, vi } from 'vitest'
import { EventTypes, ErrorTypes } from '@simple-monitor/types'
import { MonitorClient, createErrorId, clearDedup } from '@simple-monitor/core'

const baseOptions = { dsn: 'http://localhost/report', apikey: 'k' }

describe('MonitorClient（ADR-1 类化）', () => {
  it('多实例状态完全隔离：面包屑 / 配置 / 静默开关互不影响', () => {
    const a = new MonitorClient()
    const b = new MonitorClient()
    a.breadcrumb.push({ type: 'click', data: 'a-click' })
    a.setSilent(EventTypes.CONSOLE, true)
    expect(b.breadcrumb.getStack()).toHaveLength(0)
    expect(b.isSilent(EventTypes.CONSOLE)).toBe(false)
    expect(a.isSilent(EventTypes.CONSOLE)).toBe(true)
  })

  it('init 校验失败返回 false 且不绑定配置；成功返回 true', () => {
    const client = new MonitorClient()
    expect(client.init({} as any)).toBe(false)
    expect(client.init({ dsn: 'http://x' } as any)).toBe(false) // 缺 apikey
    expect(client.options.disabled).toBe(false)
    expect(client.init(baseOptions)).toBe(true)
    expect(client.transport.errorDsn).toBe('http://localhost/report')
  })

  it('init 幂等：重复调用返回 true 且不重置已绑定配置', () => {
    const client = new MonitorClient()
    expect(client.init(baseOptions)).toBe(true)
    // 第二次带不同参数：被忽略
    expect(client.init({ ...baseOptions, dsn: 'http://other/report' })).toBe(true)
    expect(client.transport.errorDsn).toBe('http://localhost/report')
  })

  it('destroy 后停止上报且清空总线/面包屑', async () => {
    const client = new MonitorClient()
    client.init(baseOptions)
    client.breadcrumb.push({ type: 'click', data: 'x' })
    client.destroy()
    expect(client.options.disabled).toBe(true)
    expect(client.breadcrumb.getStack()).toHaveLength(0)

    const xhrSpy = vi.spyOn(client.transport, 'xhrPost').mockImplementation(() => undefined)
    await client.send({ type: ErrorTypes.LOG_ERROR, message: 'm', level: 'Low', url: 'x' })
    expect(xhrSpy).not.toHaveBeenCalled()
  })

  it('事件总线：显式 id 幂等（重复注册被拒），同 type 多个匿名 handler 都触发', () => {
    const client = new MonitorClient()
    const cb = vi.fn()
    expect(client.registry.subscribe({ type: 'xhr', id: 'h1', callback: cb })).toBe(true)
    expect(client.registry.subscribe({ type: 'xhr', id: 'h1', callback: cb })).toBe(false)

    const a1 = vi.fn()
    const a2 = vi.fn()
    // 旧实现：匿名函数按 type 误去重，第二个被静默吞掉——修复后各自独立注册
    client.registry.subscribe({ type: 'fetch', callback: a1 })
    client.registry.subscribe({ type: 'fetch', callback: a2 })
    client.registry.trigger('fetch', { url: '/x' })
    expect(a1).toHaveBeenCalledTimes(1)
    expect(a2).toHaveBeenCalledTimes(1)
  })

  it('事件总线：单个 handler 抛错不影响其他 handler（错误隔离）', () => {
    const client = new MonitorClient()
    const bomb = vi.fn(() => {
      throw new Error('handler bug')
    })
    const safe = vi.fn()
    client.registry.subscribe({ type: 'error', id: 'bomb', callback: bomb })
    client.registry.subscribe({ type: 'error', id: 'safe', callback: safe })
    expect(() => client.registry.trigger('error', {})).not.toThrow()
    expect(safe).toHaveBeenCalledTimes(1)
  })

  it('clearDedup：createErrorId 去重计数可重置（测试基建）', () => {
    clearDedup()
    const data = { type: ErrorTypes.JAVASCRIPT_ERROR, name: 'Error', message: 'dedup-me' }
    expect(createErrorId(data as any, 'k', 2)).not.toBeNull()
    expect(createErrorId(data as any, 'k', 2)).not.toBeNull()
    expect(createErrorId(data as any, 'k', 2)).toBeNull()
    clearDedup()
    expect(createErrorId(data as any, 'k', 2)).not.toBeNull()
  })
})
