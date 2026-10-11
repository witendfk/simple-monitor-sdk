/* eslint-disable @typescript-eslint/no-explicit-any -- 测试替身与大载荷构造场景豁免 */
// @vitest-environment jsdom
/**
 * beacon 大信封拆批回归（§3.3 P1）：
 *  - 以 UTF-8 字节判 64KB（中日文载荷 UTF-16 length 会低估，旧实现不拆直接超限）；
 *  - 按事件偏移精确拆分：全部 beacon 合并后每个事件恰好出现一次，单片字节不超限；
 *  - 前片成功后片失败：仅失败片入缓存，已接受分段不重放。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { PROTOCOL_VERSION, type TransportEnvelope } from '@simple-monitor/protocol'
import { BatchSender, type CachedEnvelope } from '@simple-monitor/core'

const DSN = 'http://x/report'
const BEACON_MAX_BYTES = 64 * 1024

const utf8 = (s: string): number => new TextEncoder().encode(s).length

/** 每个事件带唯一标记 m${i}（ASCII 前缀 + CJK 填充：UTF-16 低估、UTF-8 超限的载荷形态） */
const bigEvent = (i: number, cjkPad: number): unknown => ({
  m: `m${i}`,
  pad: '日'.repeat(cjkPad),
})

function makeSender(beaconImpl: (...args: unknown[]) => boolean) {
  const beacon = vi.fn(beaconImpl)
  vi.stubGlobal('navigator', { sendBeacon: beacon })
  const saved: string[] = []
  const cache = {
    save: vi.fn(async (_dsn: string, json: string) => {
      saved.push(json)
    }),
    drain: vi.fn(async (): Promise<Array<CachedEnvelope & { id: number }>> => []),
    deleteById: vi.fn(async () => {}),
  }
  const sender = new BatchSender({
    buildEnvelope: (payloads) => ({
      dsn: payloads[0].dsn,
      envelope: {
        protocolVersion: PROTOCOL_VERSION,
        sentAt: 1,
        auth: { apiKey: 'k', sdk: { name: 't', version: '0' } },
        session: { sessionId: 's', trackerId: 't' },
        context: { page: 'http://x/' },
        events: payloads.map((p) => p.data) as TransportEnvelope['events'],
      },
    }),
    cache: cache as any,
  })
  return { sender, beacon, saved }
}

function markersOf(json: string): string[] {
  const env = JSON.parse(json)
  return (env.events as Array<{ m: string }>).map((e) => e.m)
}

describe('beacon 大信封拆批（§3.3 P1）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('UTF-8 判长 + 精确拆分：9 条 CJK 大事件（UTF-16 约 23KB、UTF-8 约 68KB）拆 ≥2 片，合并后每事件恰好一次，单片不超 64KB', () => {
    const { sender, beacon } = makeSender(() => true)
    for (let i = 0; i < 9; i++) sender.add(DSN, bigEvent(i, 2500))
    expect(sender.bufferedCount).toBe(9)

    sender.markLeaving()

    // 拆批确实发生：旧实现按 UTF-16 判长（~23KB < 64KB）不会拆，单片 68KB 超浏览器限额
    expect(beacon.mock.calls.length).toBeGreaterThanOrEqual(2)
    const merged = beacon.mock.calls.flatMap((c) => markersOf(c[1] as string))
    expect(merged.sort()).toEqual(Array.from({ length: 9 }, (_, i) => `m${i}`).sort())
    expect(new Set(merged).size).toBe(9) // 无重复（旧实现首段重复、后续丢失）
    for (const call of beacon.mock.calls) {
      expect(utf8(call[1] as string)).toBeLessThanOrEqual(BEACON_MAX_BYTES)
    }
    expect(sender.bufferedCount).toBe(0)
  })

  it('前片成功后片失败：仅失败片入缓存，成功片不重放', () => {
    // 第 1 片 beacon 接受，第 2 片拒绝
    const { sender, beacon, saved } = makeSender(() => beacon.mock.calls.length === 1)
    for (let i = 0; i < 9; i++) sender.add(DSN, bigEvent(i, 2500))
    sender.markLeaving()

    expect(beacon.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(saved).toHaveLength(1) // 只有失败的那一片
    const accepted = markersOf(beacon.mock.calls[0][1] as string) // 第 1 片成功
    const cachedMarkers = markersOf(saved[0])
    // 成功片与缓存片不相交（已接受分段不重放）
    expect(accepted.some((m) => cachedMarkers.includes(m))).toBe(false)
    // 并集 = 全部事件（不丢数据）
    expect([...accepted, ...cachedMarkers].sort()).toEqual(
      Array.from({ length: 9 }, (_, i) => `m${i}`).sort()
    )
  })

  it('单片路径不回归：小信封仍单次 beacon（不引入额外分片）', () => {
    const { sender, beacon } = makeSender(() => true)
    sender.add(DSN, { a: 1 })
    sender.add(DSN, { b: 2 })
    sender.markLeaving()
    expect(beacon).toHaveBeenCalledTimes(1)
    const body = JSON.parse(beacon.mock.calls[0][1] as string)
    expect(body.events).toHaveLength(2)
  })
})
