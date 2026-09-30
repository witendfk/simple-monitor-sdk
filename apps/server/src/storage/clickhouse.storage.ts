/**
 * ClickHouse 存储实现（生产形态）：明细行存 + SQL 下推聚合。
 *
 * 表结构见 docker/clickhouse/init.sql（MergeTree，TTL 30 天）。
 * 全部查询使用参数化（安全清单：禁止字符串拼接 SQL）。
 */
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { createClient, type ClickHouseClient } from '@clickhouse/client'
import type { NormalizedEvent } from '../ingest/normalize'
import type { ErrorGroup, IEventStorage, OverviewStats, PerfQuantiles } from './event-storage'

/** events 行（perf 一行一指标，unwind 后写多行） */
interface EventRow {
  ts: string
  apikey: string
  kind: string
  type: string
  release: string
  env: string
  sdkName: string
  sdkVersion: string
  sessionId: string
  trackerId: string
  page: string
  viewId: string
  device: string
  errorMessage: string
  errorName: string
  errorLevel: string
  errorId: string
  fingerprint: string
  componentName: string
  stackFrames: string
  http: string
  metricName: string
  metricValue: number
  metricScore: string
  metricDetail: string
  breadcrumbs: string
}

@Injectable()
export class ClickHouseStorage implements IEventStorage, OnApplicationShutdown {
  private readonly logger = new Logger(ClickHouseStorage.name)
  private readonly client: ClickHouseClient

  constructor(url: string) {
    this.client = createClient({ url })
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.close()
  }

  async saveBatch(events: NormalizedEvent[]): Promise<void> {
    if (events.length === 0) return
    const rows: EventRow[] = []
    for (const e of events) {
      const base = {
        ts: e.ts.toISOString().replace('T', ' ').replace('Z', ''),
        apikey: e.apikey,
        kind: e.kind,
        type: e.type,
        release: e.release ?? '',
        env: e.env ?? '',
        sdkName: e.sdkName,
        sdkVersion: e.sdkVersion,
        sessionId: e.sessionId,
        trackerId: e.trackerId,
        page: e.page,
        viewId: e.viewId ?? '',
        device: JSON.stringify(e.device ?? {}),
        errorMessage: e.error?.message ?? '',
        errorName: e.error?.name ?? '',
        errorLevel: e.error?.level ?? '',
        errorId: e.error?.errorId !== undefined ? String(e.error.errorId) : '',
        fingerprint: e.error?.fingerprint ?? '',
        componentName: e.error?.componentName ?? '',
        stackFrames: e.error ? JSON.stringify(e.error.stackFrames ?? []) : '[]',
        http: e.error?.http ? JSON.stringify(e.error.http) : '',
        metricName: e.perf?.[0]?.name ?? '',
        metricValue: e.perf?.[0]?.value ?? 0,
        metricScore: e.perf?.[0]?.score !== undefined ? String(e.perf![0].score) : '',
        metricDetail: e.perf?.[0]?.detail ? JSON.stringify(e.perf[0].detail) : '',
        breadcrumbs: e.breadcrumbs ? JSON.stringify(e.breadcrumbs) : '[]',
      }
      rows.push(base)
    }
    await this.client.insert({
      table: 'events',
      values: rows,
      format: 'JSONEachRow',
    })
  }

  async overview(apikey: string, sinceMs: number): Promise<OverviewStats> {
    const since = new Date(Date.now() - sinceMs).toISOString()
    const rs = await this.client.query({
      query: `SELECT
                count() AS total,
                countIf(kind = 'error') AS errors,
                countIf(kind = 'perf') AS perfs,
                uniqExact(sessionId) AS sessions
              FROM events WHERE apikey = {apikey:String} AND ts >= {since:DateTime}`,
      query_params: { apikey, since },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ total: string; errors: string; perfs: string; sessions: string }>()
    const row = rows[0]
    const groups = await this.errorGroups(apikey, 10, sinceMs)
    return {
      since,
      until: new Date().toISOString(),
      totalEvents: Number(row?.total ?? 0),
      errorCount: Number(row?.errors ?? 0),
      perfCount: Number(row?.perfs ?? 0),
      sessionCount: Number(row?.sessions ?? 0),
      topErrors: groups.map((g) => ({
        fingerprint: g.fingerprint,
        type: g.type,
        message: g.message,
        count: g.count,
      })),
    }
  }

  async errorGroups(apikey: string, limit: number, sinceMs?: number): Promise<ErrorGroup[]> {
    const since = new Date(Date.now() - (sinceMs ?? 7 * 24 * 3600_000)).toISOString()
    const rs = await this.client.query({
      query: `SELECT
                fingerprint,
                type,
                argMax(errorMessage, ts) AS message,
                count() AS count,
                uniqExact(sessionId) AS sessions,
                min(ts) AS firstSeen,
                max(ts) AS lastSeen,
                groupUniqArray(release) AS releases,
                argMinIf(release, ts, release != '') AS firstSeenRelease
              FROM events
              WHERE apikey = {apikey:String} AND kind = 'error' AND fingerprint != '' AND ts >= {since:DateTime}
              GROUP BY fingerprint, type
              ORDER BY count DESC
              LIMIT {limit:UInt32}`,
      query_params: { apikey, since, limit },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{
      fingerprint: string
      type: string
      message: string
      count: string
      sessions: string
      firstSeen: string
      lastSeen: string
      releases: string[]
      firstSeenRelease: string
    }>()
    return rows.map((r) => ({
      fingerprint: r.fingerprint,
      type: r.type,
      message: r.message,
      count: Number(r.count),
      affectedSessions: Number(r.sessions),
      firstSeen: new Date(r.firstSeen.replace(' ', 'T') + 'Z').toISOString(),
      lastSeen: new Date(r.lastSeen.replace(' ', 'T') + 'Z').toISOString(),
      releases: r.releases ?? [],
      firstSeenRelease: r.firstSeenRelease || undefined,
      // 样本惰性加载：组详情单独走 errorDetail，列表不拖全量堆栈
      sample: {
        kind: 'error',
        type: r.type,
        ts: new Date(r.lastSeen),
      } as unknown as NormalizedEvent,
    }))
  }

  async errorDetail(apikey: string, fingerprint: string): Promise<NormalizedEvent | null> {
    // apikey/release 必须查回透传：符号化按 (apikey, release) 匹配工件（总纲 §3.7 P1）
    const rs = await this.client.query({
      query: `SELECT apikey, release, sessionId, page, viewId, stackFrames, breadcrumbs, errorMessage, type
              FROM events
              WHERE apikey = {apikey:String} AND fingerprint = {fp:String} AND kind = 'error'
              ORDER BY ts DESC LIMIT 1`,
      query_params: { apikey, fp: fingerprint },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{
      apikey: string
      release: string
      sessionId: string
      page: string
      viewId: string
      stackFrames: string
      breadcrumbs: string
      errorMessage: string
      type: string
    }>()
    const row = rows[0]
    if (!row) return null
    return {
      kind: 'error',
      type: row.type,
      ts: new Date(),
      apikey: row.apikey,
      release: row.release || undefined,
      sdkName: '',
      sdkVersion: '',
      sessionId: row.sessionId,
      trackerId: '',
      page: row.page,
      viewId: row.viewId || undefined,
      device: {},
      error: {
        message: row.errorMessage,
        fingerprint,
        stackFrames: JSON.parse(row.stackFrames || '[]'),
      },
      breadcrumbs: JSON.parse(row.breadcrumbs || '[]'),
    }
  }

  async performanceQuantiles(
    apikey: string,
    metric: string,
    sinceMs: number
  ): Promise<PerfQuantiles> {
    const since = new Date(Date.now() - sinceMs).toISOString()
    const rs = await this.client.query({
      query: `SELECT
                count() AS count,
                quantileTDigest(0.5)(metricValue) AS p50,
                quantileTDigest(0.75)(metricValue) AS p75,
                quantileTDigest(0.95)(metricValue) AS p95
              FROM events
              WHERE apikey = {apikey:String} AND kind = 'perf' AND metricName = {metric:String} AND ts >= {since:DateTime}`,
      query_params: { apikey, metric, since },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ count: string; p50: number; p75: number; p95: number }>()
    const row = rows[0]
    return {
      metric,
      count: Number(row?.count ?? 0),
      p50: row?.p50 ?? null,
      p75: row?.p75 ?? null,
      p95: row?.p95 ?? null,
    }
  }
}
