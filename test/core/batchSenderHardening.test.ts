/* eslint-disable @typescript-eslint/no-explicit-any -- 测试替身与脏数据构造场景豁免 */
/**
 * 评审修复回归测试（P0/P1）：PO 回调隔离 / flushLeaving 防护 / 定时器重挂 / keepalive 守卫
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PROTOCOL_VERSION, type TransportEnvelope } from '@simple-monitor/protocol'
import observe from '../../packages/web-performance/src/lib/observe'
import { BatchSender, FLUSH_INTERVAL_MS } from '@simple-monitor/core'

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

describe('P0-1：observe 回调错误隔离', () => {
  class FakePO {
    static supportedEntryTypes = ['layout-shift']
    static last: ((list: any) => void) | null = null
    constructor(cb: (list: any) => void) {
      FakePO.last = cb
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    FakePO.last = null
  })

  it('单条目处理抛错不逃逸（uncaught error 不打进宿主）', () => {
    vi.stubGlobal('PerformanceObserver', FakePO)
    let processed = 0
    const po = observe('layout-shift', (entry) => {
      processed += 1
      if ((entry as any).bad) throw new Error('malformed entry')
    })
    expect(po).toBeDefined()
    const list = { getEntries: () => [{ bad: true }, { bad: false }] }
    expect(() => FakePO.last?.(list)).not.toThrow()
    expect(processed).toBe(2) // 异常不中断后续条目
  })
})

describe('P0-2：flushLeaving 序列化防护', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('envelope 含循环引用（序列化抛错）时降级最小信封，pagehide 监听器不向宿主抛异常', () => {
    const beacon = (globalThis as any).navigator.sendBeacon as ReturnType<typeof vi.fn>
    const envelope: any = { ...envelopeFixture(1), self: null }
    envelope.self = envelope // 循环引用挂在 data 之外的字段上，模拟用户数据污染
    const sender = new BatchSender({
      // 模拟用户钩子注入循环引用后的脏信封
      buildEnvelope: (payloads) => ({ dsn: payloads[0].dsn, envelope }),
    })
    sender.markLeaving()
    expect(() => sender.add('http://x/report', { a: 1 })).not.toThrow()
    // 降级最小信封（events 剥离）仍然送达
    expect(beacon).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(beacon.mock.calls[0][1])
    expect(sent.events).toEqual([])
    expect(sent.auth).toBeDefined()
  })
})

describe('P1-1：flush 后重挂定时器（多 dsn 组不滞留）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).fetch
  })

  it('A 组定量 flush 后，B 组缓冲仍能在 5s 定时触发', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))
    ;(globalThis as any).fetch = fetchMock
    const sender = new BatchSender({
      buildEnvelope: (payloads) => ({ dsn: payloads[0].dsn, envelope: envelopeFixture(1) }),
    })

    sender.add('http://b/track', { b: 1 }) // B 组先缓冲（挂上定时器）
    for (let i = 0; i < 10; i++) {
      sender.add('http://a/report', { i }) // A 组到 10 条立即 flush
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1) // A 组已发
    expect(sender.bufferedCount).toBe(1) // B 组仍在缓冲

    // 修复前：A 组 flush 清掉共享定时器，B 组滞留；修复后：定时器重挂
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('http://b/track')
  })
})

describe('P1-3：keepalive 尺寸守卫', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()

    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (globalThis as any).fetch
  })

  it('大信封（>60KB，无 gzip 路径）放弃 keepalive，小信封保留', async () => {
    // 禁用 gzip：可压缩载荷（重复字符）压后只有几百字节，守卫量的是实际发送体（正确行为），
    // 测试用不可压缩路径直接验证尺寸分支
    vi.stubGlobal('CompressionStream', undefined)
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))
    ;(globalThis as any).fetch = fetchMock
    const sender = new BatchSender({
      // 关键：信封必须真正携带载荷（否则大 payload 测不到尺寸分支）
      buildEnvelope: (payloads) => ({
        dsn: payloads[0].dsn,
        envelope: {
          ...envelopeFixture(1),
          events: [
            {
              kind: 'perf',
              metrics: [{ name: 'big', value: 1, detail: { blob: JSON.stringify(payloads) } }],
            } as any,
          ],
        },
      }),
    })

    // 大载荷：70KB 不可压缩字符
    let big = ''
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    for (let i = 0; i < 72 * 1024; i++) big += chars[i % chars.length]
    sender.add('http://x/report', {
      eventType: 'performance',
      metrics: { fps: 60, big: { value: 1, detail: big } },
    } as any)
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(false)

    // 小载荷：keepalive 保留
    sender.add('http://x/report', { eventType: 'performance', metrics: { fps: 60 } } as any)
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(fetchMock.mock.calls[1][1].keepalive).toBe(true)
  })
})
