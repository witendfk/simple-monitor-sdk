/**
 * 内存存储实现（本地开发 / 测试 / 演示）：数组 + 现算聚合。
 * 数据量级为演示级（上限保护：超过 5 万条丢最老），生产形态见 ClickHouseStorage。
 */
import { Injectable } from '@nestjs/common'
import type { NormalizedEvent } from '../ingest/normalize'
import type { ErrorGroup, IEventStorage, OverviewStats, PerfQuantiles } from './event-storage'
import { behaviorDetailFields, type TrendBucket, type PagePerf } from './event-storage'

const MAX_EVENTS = 50_000

@Injectable()
export class MemoryStorage implements IEventStorage {
  private events: NormalizedEvent[] = []
  /** 幂等去重（at-least-once 重复消费）：apikey+errorId 已入库的 error 事件跳过 */
  private readonly seenErrorIds = new Set<string>()

  async saveBatch(events: NormalizedEvent[]): Promise<void> {
    for (const e of events) {
      if (e.kind === 'error' && e.error?.errorId !== undefined) {
        const key = `${e.apikey}:${e.error.errorId}`
        if (this.seenErrorIds.has(key)) continue
        this.seenErrorIds.add(key)
      }
      this.events.push(e)
    }
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(this.events.length - MAX_EVENTS)
    }
  }

  count(): number {
    return this.events.length
  }

  async overview(apikey: string, sinceMs: number): Promise<OverviewStats> {
    const since = Date.now() - sinceMs
    const scoped = this.events.filter((e) => e.apikey === apikey && e.ts.getTime() >= since)
    const errorCount = scoped.filter((e) => e.kind === 'error').length
    const perfCount = scoped.filter((e) => e.kind === 'perf').length
    const sessions = new Set(scoped.map((e) => e.sessionId))
    const groups = await this.errorGroups(apikey, 10, sinceMs)
    return {
      since: new Date(since).toISOString(),
      until: new Date().toISOString(),
      totalEvents: scoped.length,
      errorCount,
      perfCount,
      sessionCount: sessions.size,
      topErrors: groups.map((g) => ({
        fingerprint: g.fingerprint,
        type: g.type,
        message: g.message,
        count: g.count,
      })),
    }
  }

  async errorGroups(apikey: string, limit: number, sinceMs?: number): Promise<ErrorGroup[]> {
    const since = sinceMs ? Date.now() - sinceMs : 0
    const groups = new Map<string, ErrorGroup>()
    for (const e of this.events) {
      if (e.kind !== 'error' || !e.error) continue
      if (e.apikey !== apikey || e.ts.getTime() < since) continue
      const key = e.error.fingerprint
      const existing = groups.get(key)
      if (!existing) {
        groups.set(key, {
          fingerprint: key,
          type: e.type,
          message: e.error.message,
          count: 1,
          affectedSessions: 1,
          firstSeen: e.ts.toISOString(),
          lastSeen: e.ts.toISOString(),
          releases: e.release ? [e.release] : [],
          firstSeenRelease: e.release,
          sample: e,
        })
      } else {
        if (e.release && !existing.releases.includes(e.release)) {
          existing.releases.push(e.release)
        }
        existing.count += 1
        existing.affectedSessions =
          existing.sample.sessionId === e.sessionId
            ? existing.affectedSessions
            : existing.affectedSessions + 1
        if (e.ts.toISOString() > existing.lastSeen) {
          existing.lastSeen = e.ts.toISOString()
          existing.message = e.error.message
          existing.sample = e
        }
      }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit)
  }

  async errorDetail(apikey: string, fingerprint: string): Promise<NormalizedEvent | null> {
    const matches = this.events.filter(
      (e) => e.kind === 'error' && e.apikey === apikey && e.error?.fingerprint === fingerprint
    )
    if (matches.length === 0) return null
    return matches[matches.length - 1]
  }

  async performanceQuantiles(
    apikey: string,
    metric: string,
    sinceMs: number
  ): Promise<PerfQuantiles> {
    const since = Date.now() - sinceMs
    const values = this.events
      .filter(
        (e) =>
          e.kind === 'perf' &&
          e.apikey === apikey &&
          e.type === metric &&
          e.ts.getTime() >= since &&
          e.perf?.[0]?.value !== undefined
      )
      .map((e) => e.perf![0].value)
      .sort((a, b) => a - b)
    return {
      metric,
      count: values.length,
      p50: quantile(values, 0.5),
      p75: quantile(values, 0.75),
      p95: quantile(values, 0.95),
    }
  }

  /** 行为明细全量回放（规范形状经 behaviorDetailFields，与 CH 分表列同构） */
  async recentBehaviors(apikey: string, limit: number): Promise<Array<Record<string, unknown>>> {
    return this.events
      .filter((e) => e.apikey === apikey && e.kind === 'behavior')
      .slice(-limit)
      .reverse()
      .map((e) => ({
        behaviorType: e.type,
        type: e.type,
        ts: e.ts.toISOString(),
        sessionId: e.sessionId,
        page: e.page,
        ...behaviorDetailFields((e.behavior ?? {}) as Record<string, unknown>),
      }))
  }

  /** 错误趋势：按 UTC 小时桶现算（零填充到完整 hours 窗口） */
  async errorTrend(apikey: string, hours: number): Promise<TrendBucket[]> {
    const since = Date.now() - hours * 3600_000
    const buckets = new Map<number, number>()
    for (const e of this.events) {
      if (e.apikey !== apikey || e.kind !== 'error') continue
      const ts = e.ts.getTime()
      if (ts < since) continue
      const hour = Math.floor(ts / 3600_000) * 3600_000
      buckets.set(hour, (buckets.get(hour) ?? 0) + 1)
    }
    const out: TrendBucket[] = []
    for (let h = since; h <= Date.now(); h += 3600_000) {
      out.push({ hour: new Date(h).toISOString(), count: buckets.get(h) ?? 0 })
    }
    return out
  }

  /** 页面维度 Vitals 分位（最近邻近似，与 CH quantileTDigest 语义对齐） */
  async performanceByPage(apikey: string, sinceMs: number): Promise<PagePerf[]> {
    const since = Date.now() - sinceMs
    const byPage = new Map<string, Map<string, number[]>>()
    for (const e of this.events) {
      if (e.apikey !== apikey || e.kind !== 'perf' || e.ts.getTime() < since) continue
      const metric = e.perf?.[0]
      if (!metric) continue
      const perMetric = byPage.get(e.page) ?? new Map()
      byPage.set(e.page, perMetric)
      const list = perMetric.get(metric.name) ?? []
      list.push(metric.value)
      perMetric.set(metric.name, list)
    }
    const quantile = (xs: number[], q: number): number | null => {
      if (xs.length === 0) return null
      const sorted = [...xs].sort((a, b) => a - b)
      const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
      return Math.round(sorted[Math.max(0, idx)] * 100) / 100
    }
    return [...byPage.entries()]
      .map(([page, perMetric]) => ({
        page,
        samples: [...perMetric.values()].reduce((s, xs) => s + xs.length, 0),
        lcpP75: quantile(perMetric.get('largest-contentful-paint') ?? [], 0.75),
        clsP75: quantile(perMetric.get('cumulative-layout-shift') ?? [], 0.75),
        inpP75: quantile(perMetric.get('interaction-to-next-paint') ?? [], 0.75),
        fcpP75: quantile(perMetric.get('first-contentful-paint') ?? [], 0.75),
      }))
      .sort((a, b) => b.samples - a.samples)
  }

  /** 指纹错误计数现算（Issue 对账的事实源，与 CH 聚合查询语义一致） */
  async errorCountsByFingerprint(
    apikey: string,
    fingerprints: string[]
  ): Promise<Map<string, number>> {
    const wanted = new Set(fingerprints)
    const counts = new Map<string, number>()
    for (const e of this.events) {
      if (e.apikey !== apikey || e.kind !== 'error') continue
      const fp = e.error?.fingerprint
      if (!fp || !wanted.has(fp)) continue
      counts.set(fp, (counts.get(fp) ?? 0) + 1)
    }
    return counts
  }
}

/** 最近邻分位（近似即可：演示/单测场景，CH 侧用 quantileTDigest） */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)
  return sorted[Math.max(0, idx)]
}
