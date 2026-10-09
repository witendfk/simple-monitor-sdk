// @vitest-environment jsdom
/**
 * 行为采集回归（§3.7 修复批次）：
 *  - hash 路由双触发：pushState 后仅一条 Route 面包屑（vue-router hash 模式形态）
 *  - fetch 防自循环：SDK 上报请求不进面包屑/事件
 *
 * 注意：instrumentation 页面级单例——本文件全部用例共用同一 client
 * （__monitor_wrapped 防重入使二次 init 无效，见 browser/index.ts 生命周期声明）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MonitorClient } from '@simple-monitor/core'
import { init as initBrowser } from '../../packages/browser/src/index'

const dsn = 'http://localhost/report/batch'
const baseOptions = { dsn, apikey: 'k' }

const client = new MonitorClient()
vi.spyOn(client.transport, 'send').mockResolvedValue(undefined)
// fetch 先 stub 后 init（包装绑定该引用）
;(window as unknown as { fetch: unknown }).fetch = vi
  .fn()
  .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })))
initBrowser(baseOptions, client)
// 隔离行为通道的真实发送（其 flush 走 fetch 会干扰本文件的采集断言）
client.behavior.destroy()

beforeEach(() => {
  client.breadcrumb.clear()
  history.replaceState({}, '', location.pathname)
})

describe('hash 路由去重（§3.7 双触发修复）', () => {
  it('pushState 变 hash 后，紧随的 hashchange 不再产生第二条 Route 面包屑', () => {
    history.pushState({}, '', '#/b')
    // 规范行为：变更 fragment 会异步派发 hashchange——旧实现对同一导航产生两条 Route
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const routeCrumbs = client.breadcrumb.getStack().filter((b) => b.type === 'Route')
        expect(routeCrumbs).toHaveLength(1)
        resolve()
      }, 50)
    })
  })

  it('连续 pushState 不同路由：正常导航各产生一条（去重不影响真实导航）', () => {
    history.pushState({}, '', '#/c')
    history.pushState({}, '', '#/d')
    const routeCrumbs = client.breadcrumb.getStack().filter((b) => b.type === 'Route')
    expect(routeCrumbs.length).toBeGreaterThanOrEqual(2)
  })
})

describe('fetch 防自循环（§3.7：SDK 上报请求不采集）', () => {
  it('SDK 上报地址（dsn 命中）的 fetch 不进面包屑；业务请求照常采集', async () => {
    // registry.trigger 同步可观测：dsn 请求 0 次触发、业务请求 1 次
    const triggerSpy = vi.spyOn(client.registry, 'trigger')
    await window.fetch(dsn, { method: 'POST', body: '{}' }) // 模拟 BatchSender 上报
    await window.fetch('/api/ok', { method: 'GET' })
    await new Promise((r) => setTimeout(r, 0)) // readResponseBody 的 clone().text() 微任务链
    expect(triggerSpy.mock.calls.filter(([t]) => t === 'fetch')).toHaveLength(1)
    triggerSpy.mockRestore()
  })
})
