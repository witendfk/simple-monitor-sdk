/* eslint-disable @typescript-eslint/no-explicit-any -- 测试替身与脏数据构造场景豁免（对齐 batchSenderHardening 先例） */
/**
 * 离线可靠性回路测试（M2）：重试耗尽 → 落库；恢复 → replay 重放
 * （cache 用注入替身，node 环境无 IndexedDB——真实 IDB 由 e2e 兜底）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PROTOCOL_VERSION, type TransportEnvelope } from '@simple-monitor/protocol'
import { BatchSender, EnvelopeCache, type CachedEnvelope } from '@simple-monitor/core'

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

/** 内存版缓存替身（模拟 IndexedDB 语义：save/drain/deleteById；id 自增） */
class FakeCache extends EnvelopeCache {
  public items: Array<CachedEnvelope & { id: number }> = []
  private seq = 0
  async save(dsn: string, json: string): Promise<void> {
    this.items.push({ dsn, json, sentAt: Date.now(), id: ++this.seq })
  }
  async drain(): Promise<Array<CachedEnvelope & { id: number }>> {
    return this.items
  }
  async deleteById(id: number): Promise<void> {
    this.items = this.items.filter((e) => e.id !== id)
  }
}

describe('离线可靠性回路（重试耗尽 → 落库 → replay）', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (globalThis as any).fetch
  })

  it('网络持续失败：3 次重试后落库，replay 时成功送达', async () => {
    // 前三次全部网络失败（重试耗尽），replay 阶段恢复
    fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(new Response(null, { status: 200 }))
    ;(globalThis as any).fetch = fetchMock

    const cache = new FakeCache()
    const saveSpy = vi.spyOn(cache, 'save')
    const sender = new BatchSender({
      buildEnvelope: (payloads) => ({ dsn: payloads[0].dsn, envelope: envelopeFixture(1) }),
      cache,
    })

    sender.add('http://x/report', { a: 1 })
    await vi.advanceTimersByTimeAsync(5000) // 触发 flush
    // 重试退避：500ms 抖动 → 1s → 2s，给足时间
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(cache.items).toHaveLength(1)
    expect(cache.items[0].dsn).toBe('http://x/report')

    // 恢复：replay 把缓存信封送达
    await sender.replay()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const replayInit = fetchMock.mock.calls[3][1]
    expect(replayInit.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(replayInit.body).events).toHaveLength(1)
    expect(cache.items).toHaveLength(0) // 2xx 确认后删除
  })

  it('replay 非 2xx / 网络失败：信封保留待下轮（§3.8 P1——旧实现取走即删会丢信封）', async () => {
    // replay 阶段服务端 503
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    ;(globalThis as any).fetch = fetchMock
    const cache = new FakeCache()
    const sender = new BatchSender({
      buildEnvelope: (payloads) => ({ dsn: payloads[0].dsn, envelope: envelopeFixture(1) }),
      cache,
    })
    await cache.save('http://x/report', '{"staged":true}')
    await sender.replay()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cache.items).toHaveLength(1) // 非 2xx：保留

    // 下轮网络恢复：2xx 后删除
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    await sender.replay()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(cache.items).toHaveLength(0)
  })

  it('4xx 拒绝（除 429/503）不落库——协议/权限问题重试无意义', async () => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    ;(globalThis as any).fetch = fetchMock
    const cache = new FakeCache()
    const sender = new BatchSender({
      buildEnvelope: (payloads) => ({ dsn: payloads[0].dsn, envelope: envelopeFixture(1) }),
      cache,
    })
    sender.add('http://x/report', { a: 1 })
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cache.items).toHaveLength(0)
  })

  it('buildEnvelope 抛错（脏数据）就地消化，不产生 unhandled rejection', async () => {
    fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))
    ;(globalThis as any).fetch = fetchMock
    const sender = new BatchSender({
      buildEnvelope: () => {
        throw new TypeError('circular data')
      },
      cache: new FakeCache(),
    })
    const { logger } = await import('@simple-monitor/utils')
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    sender.add('http://x/report', { a: 1 })
    // 定时器触发 flush——若异常逃逸，此处会以 unhandled rejection 判红
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
  })
})

// EnvelopeCache 在 node 环境的基础行为（no-op 降级，不可抛错）
describe('EnvelopeCache node 降级', () => {
  it('无 indexedDB 时 save/drain/deleteById 安全 no-op', async () => {
    const cache = new EnvelopeCache()
    await expect(cache.save('http://x', '{}')).resolves.toBeUndefined()
    await expect(cache.drain()).resolves.toEqual([])
    await expect(cache.deleteById(1)).resolves.toBeUndefined()
    await expect(cache.count()).resolves.toBe(0)
  })
})
