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

  it('fetch 失败路径的请求体同样脱敏（失败分支不漏 mask，§3.7 P0-1）', async () => {
    stubFetch.mockReturnValueOnce(Promise.reject(new TypeError('network down')))
    await expect(
      window.fetch('http://api.example.com/login', {
        method: 'POST',
        body: 'password=secret123&uid=42',
      })
    ).rejects.toThrow('network down')
    await new Promise((r) => setTimeout(r, 0))

    const sent = (sendSpy as any).mock.calls[0][0]
    expect(sent.request.data).toContain('[credential]')
    expect(sent.request.data).not.toContain('secret123')
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

  it('无 Content-Length 的大响应：有界采样 ≤2048 字符，业务仍完整消费（§3.3 P1）', async () => {
    const chunk = 'x'.repeat(300_000)
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 30; i++) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    stubFetch.mockReturnValueOnce(Promise.resolve(new Response(stream)))
    const biz = await window.fetch('http://api.example.com/chunked')
    const full = await biz.text() // 业务侧完整读取不受采样影响
    expect(full.length).toBe(300_000 * 30)
    await new Promise((r) => setTimeout(r, 20))

    expect(sendSpy).not.toHaveBeenCalled()
    const crumb = client.breadcrumb.getStack().find((b) => b.type === BreadCrumbTypes.FETCH)
    expect(crumb).toBeTruthy()
    expect(JSON.stringify(crumb?.data ?? '').length).toBeLessThan(3000)
  })

  it('无界持续流（不来 done）：采样后即断开产出面包屑（旧实现 text() 永挂起），原流仍可续读', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream({
      start(c) {
        controller = c
        c.enqueue(new TextEncoder().encode('hello-stream-'.repeat(400)))
      }, // 不 close：模拟持续推送的文本响应
    })
    stubFetch.mockReturnValueOnce(Promise.resolve(new Response(stream)))
    const biz = await window.fetch('http://api.example.com/never-ending')
    expect(biz.status).toBe(200)
    await new Promise((r) => setTimeout(r, 20))

    const crumb = client.breadcrumb.getStack().find((b) => b.type === BreadCrumbTypes.FETCH)
    expect(crumb).toBeTruthy() // 旧实现此处拿不到：clone().text() 对不结束的流永不 resolve
    expect(JSON.stringify(crumb?.data ?? '').length).toBeLessThan(2600)

    // 采样只断开克隆流：原流仍可继续读取
    controller!.enqueue(new TextEncoder().encode('-more'))
    controller!.close()
    expect(await biz.text()).toContain('more')
  })
})
