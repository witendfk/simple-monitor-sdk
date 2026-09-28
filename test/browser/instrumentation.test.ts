// @vitest-environment jsdom
/**
 * browser 采集层（replace）行为测试（M1）
 *
 * 页面级 instrumentation 单例语义（见 browser/src/index.ts）：本文件内
 * 首个成功 init 的 client 独占全部原生包装，后续测试复用同一 client，
 * 仅重置 spies / 面包屑 / 静默开关。fetch 采集与 web 门面见各自独立文件
 * （模块级包装状态需文件级隔离）。
 *
 * 锁定的 M1 修复项：
 *  - init 失败短路（不装载采集器）
 *  - init 幂等 + 换 client 告警忽略（页面单例语义显式化）
 *  - traceparent 注入（ADR-7，请求头与上报对齐）
 *  - safeResponseText（responseType != text 不抛错）
 *  - filterXhrUrlRegExp 真正生效
 *  - silentResource 独立开关（不再被 silentError 连带）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventTypes, ErrorTypes, BreadCrumbTypes } from '@simple-monitor/types'
import { logger, MonitorClient } from '@simple-monitor/core'
import { init as initBrowser } from '../../packages/browser/src/index'

/** 最小可用 XHR 替身：记录 open/setRequestHeader/send，手动触发完成 */
class FakeXHR {
  readyState = 0
  status = 0
  responseText = ''
  responseType: string = ''
  withCredentials = false
  headers: Record<string, string> = {}
  method = ''
  url = ''
  private listener: ((e: Event) => void) | null = null
  open(method: string, url: string): void {
    this.method = method
    this.url = url
    this.readyState = 1
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k] = v
  }
  send(): void {}
  addEventListener(type: string, fn: (e: Event) => void): void {
    if (type === 'readystatechange') this.listener = fn
  }
  /** 模拟请求完成 */
  fire(status = 500, responseText = 'boom-page'): void {
    this.readyState = 4
    this.status = status
    this.responseText = responseText
    this.listener?.(new Event('readystatechange'))
  }
}

const baseOptions = { dsn: 'http://localhost/report', apikey: 'k' }

describe('browser 采集层（jsdom + FakeXHR）', () => {
  const RealXHR = (globalThis as any).XMLHttpRequest
  /** 本文件内独占 instrumentation 的 client（首个成功 init 绑定） */
  let client: MonitorClient

  beforeEach(() => {
    ;(globalThis as any).XMLHttpRequest = FakeXHR
    vi.restoreAllMocks()
    client?.breadcrumb.clear()
    client?.flags.clear()
  })
  afterEach(() => {
    ;(globalThis as any).XMLHttpRequest = RealXHR
  })

  it('init 失败短路：缺 apikey 时不包装 XMLHttpRequest、不绑定 instrumentation', () => {
    const throwaway = new MonitorClient()
    const ok = initBrowser({ dsn: 'http://x' } as any, throwaway)
    expect(ok).toBe(false)
    expect((FakeXHR.prototype as any).__monitor_wrapped).toBeUndefined()
  })

  it('首次成功 init：包装原型；重复 init 幂等；换 client 告警忽略', () => {
    client = new MonitorClient()
    expect(initBrowser(baseOptions, client)).toBe(true)
    const wrappedOpen = FakeXHR.prototype.open as any
    expect(wrappedOpen.__monitor_wrapped).toBe(true)
    expect(initBrowser(baseOptions, client)).toBe(true)
    expect(FakeXHR.prototype.open).toBe(wrappedOpen)
    // 换 client 再 init：显式告警并忽略（页面单例语义），不静默错绑
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    expect(initBrowser(baseOptions, new MonitorClient())).toBe(true)
    expect(FakeXHR.prototype.open).toBe(wrappedOpen)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('HTTP 错误（5xx）触发上报，响应体被截断采集', async () => {
    const sendSpy = vi.spyOn(client.transport, 'send').mockResolvedValue(undefined)

    const xhr = new FakeXHR()
    xhr.open('GET', 'http://api.example.com/users/123')
    xhr.send()
    xhr.fire(500)

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const sent = (sendSpy as any).mock.calls[0][0]
    expect(sent.type).toBe(ErrorTypes.FETCH_ERROR)
    expect(sent.response.status).toBe(500)
    expect(sent.response.data).toBe('boom-page')
    // 面包屑同样记录本次 HTTP
    expect(client.breadcrumb.getStack().some((b) => b.type === BreadCrumbTypes.XHR)).toBe(true)
  })

  it('traceparent 注入：命中正则时请求头与上报 traceId 对齐（ADR-7）', async () => {
    client.options.enableTraceId = true
    client.options.includeHttpUrlTraceIdRegExp = /api\.example\.com/
    client.options.traceIdFieldName = 'traceparent'
    const sendSpy = vi.spyOn(client.transport, 'send').mockResolvedValue(undefined)

    const xhr = new FakeXHR()
    xhr.open('GET', 'https://api.example.com/orders/456')
    xhr.send()
    const injected = xhr.headers['traceparent']
    expect(injected).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    xhr.fire(500)

    const sent = (sendSpy as any).mock.calls[0][0]
    // 上报的 traceId === 注入请求头的 traceId（旧版只生成不注入——已修复）
    expect(sent.request.traceId).toBe(injected)
  })

  it('traceparent 不注入：未命中正则时不设头', () => {
    client.options.enableTraceId = true
    client.options.includeHttpUrlTraceIdRegExp = /never-match\.example/
    const xhr = new FakeXHR()
    xhr.open('GET', 'https://api.example.com/a')
    expect(xhr.headers['traceparent']).toBeUndefined()
  })

  it('responseType=json 时安全读取：不抛 InvalidStateError，记占位标记', async () => {
    const sendSpy = vi.spyOn(client.transport, 'send').mockResolvedValue(undefined)

    const xhr = new FakeXHR()
    xhr.open('GET', 'http://api.example.com/json-api')
    xhr.send()
    expect(() => {
      xhr.responseType = 'json'
      xhr.fire(500, 'ignored')
    }).not.toThrow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const sent = (sendSpy as any).mock.calls[0][0]
    expect(sent.response.data).toBe('[json]')
  })

  it('filterXhrUrlRegExp：命中 URL 完全不监控（无面包屑、不上报）', async () => {
    client.options.filterXhrUrlRegExp = /\/private\//
    const sendSpy = vi.spyOn(client.transport, 'send').mockResolvedValue(undefined)

    const xhr = new FakeXHR()
    xhr.open('POST', 'http://api.example.com/private/pay')
    xhr.send()
    xhr.fire(500)

    expect(sendSpy).not.toHaveBeenCalled()
    expect(client.breadcrumb.getStack().some((b) => b.type === BreadCrumbTypes.XHR)).toBe(false)
  })

  it('silentResource 独立开关：silentError 不再连带静默资源错误', () => {
    const sendSpy = vi.spyOn(client.transport, 'send').mockResolvedValue(undefined)
    // 只静默 JS 错误：资源错误应照常上报
    client.setSilent(EventTypes.ERROR, true)

    const img = document.createElement('img')
    const evt = new ErrorEvent('error')
    Object.defineProperty(evt, 'target', { value: img })
    window.dispatchEvent(evt)

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect((sendSpy as any).mock.calls[0][0].type).toBe(ErrorTypes.RESOURCE_ERROR)

    // 显式 silentResource=true 才静默资源错误
    const sendSpy2 = vi.spyOn(client.transport, 'send').mockResolvedValue(undefined)
    client.setSilent(EventTypes.RESOURCE_ERROR_EVENT, true)
    const evt2 = new ErrorEvent('error')
    Object.defineProperty(evt2, 'target', { value: document.createElement('img') })
    window.dispatchEvent(evt2)
    expect(sendSpy2).not.toHaveBeenCalled()
  })
})
