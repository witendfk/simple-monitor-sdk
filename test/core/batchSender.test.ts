// @vitest-environment jsdom
/**
 * BatchSender 行为测试（M2）：定量/定时 flush、重试退避、通道状态机、beacon 离场
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PROTOCOL_VERSION, type TransportEnvelope } from '@simple-monitor/protocol'
import { BatchSender, MAX_BATCH_EVENTS, FLUSH_INTERVAL_MS } from '@simple-monitor/core'

const envelopeFixture = (n: number): TransportEnvelope => ({
  protocolVersion: PROTOCOL_VERSION,
  sentAt: Date.now(),
  auth: { apiKey: 'k', sdk: { name: 't', version: '0' } },
  session: { sessionId: 's', trackerId: 't' },
  context: { page: 'http://x/' },
  events: Array.from({ length: n }, () => ({
    kind: 'perf',
    metrics: [{ name: 'fps', value: 60 }],
  })),
})

function makeSender(overrides: Partial<{ fetch: ReturnType<typeof vi.fn> }> = {}) {
  const fetchMock =
    overrides.fetch ?? vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))
  ;(globalThis as any).fetch = fetchMock
  const sender = new BatchSender({
    buildEnvelope: (payloads) => ({
      dsn: payloads[0].dsn,
      envelope: envelopeFixture(payloads.length),
    }),
  })
  return { sender, fetchMock }
}

describe('BatchSender（M2 可靠性引擎）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).fetch
  })

  it('定量触发：第 10 条入队即 flush', async () => {
    const { sender, fetchMock } = makeSender()
    for (let i = 0; i < MAX_BATCH_EVENTS; i++) {
      sender.add('http://x/report', { i })
    }
    expect(sender.bufferedCount).toBe(0) // 已 flush
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://x/report')
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    const body = JSON.parse(init.body)
    expect(body.events).toHaveLength(MAX_BATCH_EVENTS)
  })

  it('定时触发：不足 10 条时 5s 定时 flush', async () => {
    const { sender, fetchMock } = makeSender()
    sender.add('http://x/report', { a: 1 })
    expect(sender.bufferedCount).toBe(1)
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sender.bufferedCount).toBe(0)
  })

  it('5xx 重试：失败两次后成功（指数退避）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const { sender } = makeSender({ fetch: fetchMock })
    sender.add('http://x/report', { a: 1 })
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    // 重试等待：500ms + 抖动 → 1s+ → 2s+
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sender.bufferedCount).toBe(0)
  })

  it('429 尊重 Retry-After；4xx（除 429/503）直接丢弃不重试', async () => {
    const fetchMock429 = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const a = makeSender({ fetch: fetchMock429 })
    a.sender.add('http://x/report', { a: 1 })
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fetchMock429).toHaveBeenCalledTimes(2)

    const fetchMock403 = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    const b = makeSender({ fetch: fetchMock403 })
    b.sender.add('http://x/report', { b: 1 })
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock403).toHaveBeenCalledTimes(1) // 不重试
    expect(b.sender.bufferedCount).toBe(0) // 不回缓冲（丢弃）
  })

  it('通道状态机：leaving 下新事件同步走 beacon，恢复 active 后回到批量通道', () => {
    const beacon = vi.fn(() => true)
    vi.stubGlobal('navigator', { sendBeacon: beacon })
    const { sender, fetchMock } = makeSender()

    sender.markLeaving()
    expect(sender.getState()).toBe('leaving')
    sender.add('http://x/report', { leaving: 1 })
    expect(beacon).toHaveBeenCalledTimes(1)
    expect(beacon.mock.calls[0][0]).toBe('http://x/report')
    expect(sender.bufferedCount).toBe(0)

    sender.markActive()
    sender.add('http://x/report', { active: 1 })
    expect(sender.bufferedCount).toBe(1)
    expect(beacon).toHaveBeenCalledTimes(1)
    void fetchMock
  })

  it('主动期 flush 走 fetch；markLeaving 立即排空缓冲走 beacon', () => {
    const beacon = vi.fn(() => true)
    vi.stubGlobal('navigator', { sendBeacon: beacon })
    const { sender, fetchMock } = makeSender()
    sender.add('http://x/report', { a: 1 })
    sender.add('http://x/report', { b: 2 })
    expect(sender.bufferedCount).toBe(2)
    sender.markLeaving()
    // 排空走 beacon（一次信封包含两条）
    expect(beacon).toHaveBeenCalledTimes(1)
    const body = JSON.parse(beacon.mock.calls[0][1])
    expect(body.events).toHaveLength(2)
    expect(sender.bufferedCount).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('beforeSend 钩子返回 falsy 取消发送（configReportUrl 兼容语义）', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))
    ;(globalThis as any).fetch = fetchMock
    const sender = new BatchSender({
      buildEnvelope: (payloads) => ({ dsn: payloads[0].dsn, envelope: envelopeFixture(1) }),
      beforeSend: () => false,
    })
    sender.add('http://x/report', { a: 1 })
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
