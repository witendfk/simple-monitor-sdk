// @vitest-environment jsdom
/**
 * fetch 采集测试（M1）——独立文件：fetch 包装发生在 init 时刻且绑定
 * window.fetch 引用（jsdom 无原生 fetch，必须 stub 在 window 上、先于 init）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ErrorTypes, BreadCrumbTypes } from '@simple-monitor/types'
import { MonitorClient } from '@simple-monitor/core'
import { init as initBrowser } from '../../packages/browser/src/index'

const baseOptions = { dsn: 'http://localhost/report', apikey: 'k' }

describe('fetch 采集（window.fetch 先 stub 后 init）', () => {
  const client = new MonitorClient()
  const sendSpy = vi.spyOn(client.transport, 'send').mockResolvedValue(undefined)
  const stubFetch = vi.fn()

  // 关键顺序：先 stub window.fetch，再 init（包装绑定该引用）
  ;(window as any).fetch = stubFetch
  initBrowser(baseOptions, client)

  beforeEach(() => {
    client.breadcrumb.clear()
    sendSpy.mockClear()
  })

  it('fetch 失败（reject）上报 FETCH_ERROR status=0，异常原样抛回业务', async () => {
    stubFetch.mockReturnValueOnce(Promise.reject(new TypeError('network down')))
    await expect(window.fetch('http://api.example.com/fail')).rejects.toThrow('network down')
    await new Promise((r) => setTimeout(r, 0))

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const sent = (sendSpy as any).mock.calls[0][0]
    expect(sent.type).toBe(ErrorTypes.FETCH_ERROR)
    expect(sent.response.status).toBe(0)
    expect(sent.message).toContain('跨域限制或域名不存在')
  })

  it('fetch 5xx 二进制大响应：采集状态但跳过 body 读取（防内存膨胀）', async () => {
    stubFetch.mockReturnValueOnce(
      Promise.resolve(
        new Response('ignored', {
          status: 500,
          headers: { 'content-type': 'video/mp4', 'content-length': '1073741824' },
        })
      )
    )
    await window.fetch('http://api.example.com/video')
    await new Promise((r) => setTimeout(r, 0))

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const sent = (sendSpy as any).mock.calls[0][0]
    expect(sent.response.status).toBe(500)
    expect(sent.response.data).toBe('[skipped:binary-or-large]')
  })

  it('fetch 2xx：只进面包屑不上报', async () => {
    stubFetch.mockReturnValueOnce(Promise.resolve(new Response('{"ok":1}', { status: 200 })))
    await window.fetch('http://api.example.com/ok')
    await new Promise((r) => setTimeout(r, 0))

    expect(sendSpy).not.toHaveBeenCalled()
    expect(client.breadcrumb.getStack().some((b) => b.type === BreadCrumbTypes.FETCH)).toBe(true)
  })
})
