// @vitest-environment jsdom
/**
 * Transport M2 集成测试：send() → 批量缓冲 → 协议信封（采样 / release / env / 会话注入）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ErrorTypes } from '@simple-monitor/types'
import { MonitorClient, clearDedup } from '@simple-monitor/core'

const baseOptions = { dsn: 'http://localhost/report', apikey: 'k' }

describe('Transport M2 集成（send → 批量通道）', () => {
  let client: MonitorClient
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    // errorId 去重是会话级（sessionStorage），jsdom 文件内跨用例共享——隔离之
    clearDedup()
    fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))
    ;(globalThis as any).fetch = fetchMock
    client = new MonitorClient()
    client.init(baseOptions)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).fetch
  })

  it('错误 send 进入批量缓冲，5s 定时 flush 出协议信封（含面包屑快照）', async () => {
    // 先产生一条行为面包屑，验证随错误信封上报
    client.breadcrumb.push({
      type: 'Click',
      category: 'user',
      data: '<button>提交</button>',
      time: 1,
    })
    await client.transport.send({
      type: ErrorTypes.LOG_ERROR,
      message: 'm',
      level: 'Low',
      url: 'http://x/',
    })
    expect(client.transport.bufferedCount).toBe(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost/report')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    const envelope = JSON.parse(init.body)
    expect(envelope.protocolVersion).toBe(1)
    expect(envelope.auth.apiKey).toBe('k')
    expect(envelope.session.sessionId).toBeTruthy()
    expect(envelope.events[0].kind).toBe('error')
    expect(envelope.events[0].error.message).toBe('m')
    // 面包屑随错误事件上报（flush 时刻快照）
    expect(Array.isArray(envelope.events[0].breadcrumbs)).toBe(true)
  })

  it('release/env 注入信封 auth；trackerId 来自 SessionManager', async () => {
    client.transport.bindOptions({ ...baseOptions, release: 'v2.0.0', env: 'staging' })
    await client.transport.send({
      type: ErrorTypes.LOG_ERROR,
      message: 'm',
      level: 'Low',
      url: 'http://x/',
    })
    await vi.advanceTimersByTimeAsync(5000)
    const envelope = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(envelope.auth.release).toBe('v2.0.0')
    expect(envelope.auth.env).toBe('staging')
    expect(typeof envelope.session.trackerId).toBe('string')
  })

  it('性能采样：sampleRate=0 时 perf 不进缓冲，错误不受影响（错误始终 100%）', async () => {
    client.options.sampleRate = 0
    await client.transport.send({ eventType: 'performance', metrics: { fps: 60 } } as any)
    expect(client.transport.bufferedCount).toBe(0)

    await client.transport.send({
      type: ErrorTypes.LOG_ERROR,
      message: 'm',
      level: 'Low',
      url: 'http://x/',
    })
    expect(client.transport.bufferedCount).toBe(1)
  })

  it('性能数据归一进协议：value=number，富信息进 detail，设备进 context.device', async () => {
    client.transport.deviceInfo = { browser: 'chrome', screen: '1920x1080' } as any
    await client.transport.send({
      eventType: 'performance',
      metrics: {
        fps: 60,
        'interaction-to-next-paint': { duration: 88, eventName: 'click' },
      },
    } as any)
    await vi.advanceTimersByTimeAsync(5000)
    const envelope = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(envelope.events[0].kind).toBe('perf')
    const byName = Object.fromEntries(envelope.events[0].metrics.map((m: any) => [m.name, m]))
    expect(byName['fps'].value).toBe(60)
    expect(byName['interaction-to-next-paint'].value).toBe(88)
    expect(byName['interaction-to-next-paint'].detail.eventName).toBe('click')
    expect(envelope.context.device).toEqual({ browser: 'chrome', screen: '1920x1080' })
  })

  it('maxDuplicateCount 去重在批量通道下依旧生效（同错误第 3 次起丢弃）', async () => {
    const error = () => ({
      type: ErrorTypes.LOG_ERROR,
      message: 'dup',
      level: 'Low',
      url: 'http://x/',
    })
    await client.transport.send(error())
    await client.transport.send(error())
    await client.transport.send(error()) // 第 3 次：超过默认阈值 2 → 丢弃
    expect(client.transport.bufferedCount).toBe(2)
  })
})
