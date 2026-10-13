/**
 * Memory / ClickHouse 明细与聚合等价性测试（M7.5 P2 验收）。
 * CLICKHOUSE_URL 在位才跑（本地 docker；CI 无 docker 自动跳过）。
 * 同一批规范化数据分别写入两种存储，断言：
 *  - recentBehaviors 明细一致（PV 来源 UTM / track 属性 / 停留时长——P2 明细完整性）
 *  - overview 计数一致
 *  - errorGroups 分组核心字段一致
 *  - performanceQuantiles 一致
 *  - errorCountsByFingerprint 一致（Issue 对账事实源）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { TransportEnvelope } from '@simple-monitor/protocol'
import { PROTOCOL_VERSION } from '@simple-monitor/protocol'
import { MemoryStorage } from '../src/storage/memory.storage'
import { ClickHouseStorage } from '../src/storage/clickhouse.storage'
import { normalizeEnvelope } from '../src/ingest/normalize'

const CH_URL = process.env.CLICKHOUSE_URL ?? ''

const KEY = `eq-${Date.now().toString(36)}`

function envelope(id: number, sentAt: number): TransportEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sentAt,
    auth: { apiKey: KEY, release: 'v2.0.0', env: 'eq', sdk: { name: 'eq', version: '0.0.1' } },
    session: { sessionId: `eq-sess-${id}`, trackerId: 'eq-track-1' },
    context: { page: '/checkout' },
    events: [
      {
        kind: 'behavior',
        behavior: {
          behaviorType: 'page_view',
          url: '/checkout?token=x',
          loadType: 'navigate',
          referrerHost: 'google.com',
          utmSource: 'newsletter',
          utmMedium: 'email',
          utmCampaign: 'launch',
        },
      },
      {
        kind: 'behavior',
        behavior: {
          behaviorType: 'track',
          name: 'submit_order',
          props: { plan: 'pro', itemCount: 3 },
          from: 'declarative',
        },
      },
      {
        kind: 'behavior',
        behavior: {
          behaviorType: 'page_dwell',
          activeMs: 42_000,
          startTime: sentAt - 42_000,
          endTime: sentAt,
        },
      },
      {
        kind: 'api',
        api: {
          method: 'POST',
          url: '/api/orders',
          status: 201,
          durationMs: 123,
          traceId: 'trace-eq-1',
        },
      },
      {
        kind: 'error',
        error: {
          type: 'JAVASCRIPT_ERROR',
          message: 'eq: cannot read property amount',
          time: sentAt,
          stackFrames: [{ url: 'http://x.com/app.js', func: 'submit', line: 42, column: 7 }],
        },
        breadcrumbs: [{ type: 'Click', data: '<button>下单</button>', time: sentAt }],
      },
      { kind: 'perf', metrics: [{ name: 'largest-contentful-paint', value: 2100 }] },
    ],
  }
}

/** 送一封信封（含 sentAt 间隔 ≥1s 保证 CH 秒级 ts 排序确定） */
function envelopes(): TransportEnvelope[] {
  const base = Date.now() - 60_000
  return [0, 2_000, 4_000].map((offset, i) => envelope(i + 1, base + offset))
}

/** 递归键排序规范化（消除键序差异，嵌套 props 也参与比较） */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    )
  }
  return value
}

/** 规范化比较：CH DateTime 秒级精度，ts 统一截断到秒后递归键排序 */
function stable(value: unknown): string {
  const v = canonical(value) as Record<string, unknown>
  if (typeof v['ts'] === 'string') v['ts'] = v['ts'].replace(/\.\d{3}Z$/, 'Z')
  return JSON.stringify(v)
}

describe.skipIf(!CH_URL)('Memory / CH 等价性（M7.5 P2 明细完整性验收）', () => {
  let memory: MemoryStorage
  let ch: ClickHouseStorage

  beforeAll(async () => {
    memory = new MemoryStorage()
    ch = new ClickHouseStorage(
      CH_URL,
      process.env.CLICKHOUSE_USERNAME,
      process.env.CLICKHOUSE_PASSWORD
    )
    for (const env of envelopes()) {
      const { events } = normalizeEnvelope(env)
      await memory.saveBatch(events)
      await ch.saveBatch(events)
    }
  }, 30_000)

  afterAll(async () => {
    await ch.onApplicationShutdown()
  })

  it('recentBehaviors 明细一致：PV 来源 / track 属性 / 停留时长全字段', async () => {
    const memRows = await memory.recentBehaviors(KEY, 20)
    const chRows = await ch.recentBehaviors(KEY, 20)
    expect(chRows).toHaveLength(memRows.length)
    const memSorted = [...memRows].sort((a, b) => stable(a).localeCompare(stable(b)))
    const chSorted = [...chRows].sort((a, b) => stable(a).localeCompare(stable(b)))
    expect(chSorted.map(stable)).toEqual(memSorted.map(stable))
    // 关键明细字段显式断言（PV 来源归因 + track 属性 + 停留）
    const pv = chRows.find((r) => r['behaviorType'] === 'page_view') as Record<string, unknown>
    expect(pv).toMatchObject({
      url: '/checkout',
      loadType: 'navigate',
      referrerHost: 'google.com',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'launch',
    })
    const track = chRows.find((r) => r['behaviorType'] === 'track') as Record<string, unknown>
    expect(track).toMatchObject({
      name: 'submit_order',
      props: { plan: 'pro', itemCount: 3 },
      from: 'declarative',
    })
    const dwell = chRows.find((r) => r['behaviorType'] === 'page_dwell') as Record<string, unknown>
    expect(dwell['dwellMs']).toBe(42_000)
  })

  it('overview 计数一致', async () => {
    const mem = await memory.overview(KEY, 60 * 60_000)
    const chi = await ch.overview(KEY, 60 * 60_000)
    expect(chi.totalEvents).toBe(mem.totalEvents)
    expect(chi.errorCount).toBe(mem.errorCount)
    expect(chi.perfCount).toBe(mem.perfCount)
    expect(chi.sessionCount).toBe(mem.sessionCount)
    expect(chi.totalEvents).toBeGreaterThan(0)
  })

  it('errorGroups 分组核心字段一致', async () => {
    const mem = await memory.errorGroups(KEY, 10)
    const chi = await ch.errorGroups(KEY, 10)
    expect(chi).toHaveLength(mem.length)
    for (const [m, c] of mem.map((m, i) => [m, chi[i]] as const)) {
      expect(c.fingerprint).toBe(m.fingerprint)
      expect(c.type).toBe(m.type)
      expect(c.count).toBe(m.count)
      expect(c.message).toBe(m.message)
    }
  })

  it('performanceQuantiles 一致', async () => {
    const mem = await memory.performanceQuantiles(KEY, 'largest-contentful-paint', 60 * 60_000)
    const chi = await ch.performanceQuantiles(KEY, 'largest-contentful-paint', 60 * 60_000)
    expect(chi.count).toBe(mem.count)
    for (const q of ['p50', 'p75', 'p95'] as const) {
      // tdigest 近似：±10ms 容差（3 样本应精确，留余量防实现差异）
      expect(Math.abs((chi[q] ?? 0) - (mem[q] ?? 0))).toBeLessThanOrEqual(10)
    }
  })

  it('errorCountsByFingerprint 一致（Issue 对账事实源）', async () => {
    const mem = await memory.errorCountsByFingerprint(KEY, ['fp-a', 'fp-b'])
    const groups = await memory.errorGroups(KEY, 10)
    const fps = groups.map((g) => g.fingerprint)
    const memCounts = await memory.errorCountsByFingerprint(KEY, fps)
    const chCounts = await ch.errorCountsByFingerprint(KEY, fps)
    expect([...chCounts.entries()]).toEqual([...memCounts.entries()])
    expect(memCounts.size).toBeGreaterThan(0)
    void mem
  })
})
