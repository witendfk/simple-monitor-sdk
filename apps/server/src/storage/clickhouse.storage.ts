/**
 * ClickHouse 存储（M7.5 P2 分表形态）：error/perf/behavior/api 四表替代 M4 单宽表，
 * 事实 append-only，可变状态归 PG（ADR-4 职责铁律）。
 *
 * 明细完整性（P2 验收）：behavior_events 保留事件名/属性/PV 来源（UTM）/停留时长，
 * api_events 保留 method/url/status/duration/trace_id——与 Memory 形态明细等价
 * （equivalence 测试锁定）。聚合优先读物化视图的口径由 M8 查询层接入，本层直查明细。
 */
import { Injectable, type OnApplicationShutdown } from '@nestjs/common'
import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { toClickHouseDateTime } from './clickhouse-datetime'
import type { NormalizedEvent } from '../ingest/normalize'
import type { ErrorGroup, IEventStorage, OverviewStats, PerfQuantiles } from './event-storage'
import { behaviorDetailFields, type PagePerf, type TrendBucket } from './event-storage'

/** 错误行（error_events 表，列名 snake_case） */
interface ErrorRow extends HeadRow {
  type: string
  resource_kind: string
  errorName: string
  errorLevel: string
  errorId: string
  fingerprint: string
  componentName: string
  message: string
  message_head: string
  stack_frames: string
  http: string
  breadcrumbs: string
}

/** perf 一行一指标（unwind 后） */
interface PerfRow extends HeadRow {
  metric_name: string
  metric_value: number
  metric_score: number
  metric_detail: string
}

interface BehaviorRow extends HeadRow {
  behavior_type: string
  name: string
  props: string
  url: string
  load_type: string
  referrer_host: string
  utm_source: string
  utm_medium: string
  utm_campaign: string
  selector: string
  dwell_ms: number
  from_source: string
}

interface ApiRow extends HeadRow {
  method: string
  url: string
  status: number
  duration_ms: number
  is_slow: number
  trace_id: string
}

/** 行公共头（四表共享列） */
interface HeadRow {
  ts: string
  apikey: string
  release: string
  env: string
  sdkName: string
  sdkVersion: string
  sessionId: string
  trackerId: string
  page: string
  viewId: string
  device: string
}

function commonHead(e: NormalizedEvent, ts: string): HeadRow {
  return {
    ts,
    apikey: e.apikey,
    release: e.release ?? '',
    env: e.env ?? '',
    sdkName: e.sdkName,
    sdkVersion: e.sdkVersion,
    sessionId: e.sessionId,
    trackerId: e.trackerId,
    page: e.page,
    viewId: e.viewId ?? '',
    device: JSON.stringify(e.device ?? {}),
  }
}

/**
 * behavior 明细到列的映射（与 Memory 形态 recentBehaviors 输出同构，equivalence 锁定）。
 * 返回新对象不改写入参——载荷在队列重放时会复用。
 */
export function behaviorEventToRow(e: NormalizedEvent, ts: string): BehaviorRow {
  const b = (e.behavior ?? {}) as Record<string, unknown>
  const str = (k: string): string => (typeof b[k] === 'string' ? (b[k] as string) : '')
  const dwell =
    typeof b['activeMs'] === 'number'
      ? Math.max(0, Math.round(b['activeMs'] as number))
      : typeof b['dwellMs'] === 'number'
        ? Math.max(0, Math.round(b['dwellMs'] as number))
        : 0
  return {
    ...commonHead(e, ts),
    behavior_type: e.type,
    name: str('name'),
    props: b['props'] !== undefined ? JSON.stringify(b['props']) : '',
    url: str('url'),
    load_type: str('loadType'),
    referrer_host: str('referrerHost'),
    utm_source: str('utmSource'),
    utm_medium: str('utmMedium'),
    utm_campaign: str('utmCampaign'),
    selector: str('selector'),
    dwell_ms: dwell,
    from_source: str('from'),
  }
}

export function apiEventToRow(e: NormalizedEvent, ts: string): ApiRow {
  const a = (e.api ?? {}) as Record<string, unknown>
  const num = (k: string): number => (typeof a[k] === 'number' ? (a[k] as number) : 0)
  const duration = num('durationMs')
  return {
    ...commonHead(e, ts),
    method: typeof a['method'] === 'string' ? (a['method'] as string) : '',
    url: typeof a['url'] === 'string' ? (a['url'] as string) : '',
    status: Math.round(num('status')),
    duration_ms: Math.max(0, Math.round(duration)),
    is_slow: a['slow'] === true ? 1 : 0,
    trace_id: typeof a['traceId'] === 'string' ? (a['traceId'] as string) : '',
  }
}

@Injectable()
export class ClickHouseStorage implements IEventStorage, OnApplicationShutdown {
  private readonly client: ClickHouseClient

  constructor(url: string, username = 'default', password = '') {
    this.client = createClient({ url, username, password })
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.close()
  }

  async saveBatch(events: NormalizedEvent[]): Promise<void> {
    if (events.length === 0) return
    const errors: ErrorRow[] = []
    const perfs: PerfRow[] = []
    const behaviors: BehaviorRow[] = []
    const apis: ApiRow[] = []
    for (const e of events) {
      const ts = toClickHouseDateTime(e.ts)
      if (e.kind === 'error' && e.error) {
        errors.push({
          ...commonHead(e, ts),
          type: e.type,
          resource_kind: e.error.resourceKind ?? '',
          errorName: e.error.name ?? '',
          errorLevel: e.error.level ?? '',
          errorId: e.error.errorId !== undefined ? String(e.error.errorId) : '',
          fingerprint: e.error.fingerprint,
          componentName: e.error.componentName ?? '',
          message: e.error.message,
          message_head: e.error.message.slice(0, 128),
          stack_frames: JSON.stringify(e.error.stackFrames ?? []),
          http: e.error.http ? JSON.stringify(e.error.http) : '',
          breadcrumbs: JSON.stringify(e.breadcrumbs ?? []),
        })
      } else if (e.kind === 'perf') {
        for (const m of e.perf ?? []) {
          perfs.push({
            ...commonHead(e, ts),
            metric_name: m.name,
            metric_value: m.value,
            metric_score: m.score ?? 0,
            metric_detail: m.detail ? JSON.stringify(m.detail) : '',
          })
        }
      } else if (e.kind === 'behavior') {
        behaviors.push(behaviorEventToRow(e, ts))
      } else if (e.kind === 'api') {
        apis.push(apiEventToRow(e, ts))
      }
      // kind='replay'：协议占位（回放预留），无列可落——静默跳过
    }
    // 分表写入：每域一次批量 INSERT；单域失败抛出走队列重试（整批 at-least-once）
    if (errors.length > 0) {
      await this.client.insert({ table: 'error_events', values: errors, format: 'JSONEachRow' })
    }
    if (perfs.length > 0) {
      await this.client.insert({ table: 'perf_events', values: perfs, format: 'JSONEachRow' })
    }
    if (behaviors.length > 0) {
      await this.client.insert({
        table: 'behavior_events',
        values: behaviors,
        format: 'JSONEachRow',
      })
    }
    if (apis.length > 0) {
      await this.client.insert({ table: 'api_events', values: apis, format: 'JSONEachRow' })
    }
  }

  async overview(apikey: string, sinceMs: number): Promise<OverviewStats> {
    const since = toClickHouseDateTime(new Date(Date.now() - sinceMs))
    const rs = await this.client.query({
      query: `SELECT
                count() AS total,
                countIf(kind = 'error') AS errors,
                countIf(kind = 'perf') AS perfs,
                uniqExact(sessionId) AS sessions
              FROM (
                SELECT 'error' AS kind, ts, sessionId FROM error_events
                  WHERE apikey = {apikey:String} AND ts >= {since:DateTime}
                UNION ALL SELECT 'perf', ts, sessionId FROM perf_events
                  WHERE apikey = {apikey:String} AND ts >= {since:DateTime}
                UNION ALL SELECT 'behavior', ts, sessionId FROM behavior_events
                  WHERE apikey = {apikey:String} AND ts >= {since:DateTime}
                UNION ALL SELECT 'api', ts, sessionId FROM api_events
                  WHERE apikey = {apikey:String} AND ts >= {since:DateTime}
              )`,
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
    const since = toClickHouseDateTime(new Date(Date.now() - (sinceMs ?? 7 * 24 * 3600_000)))
    const rs = await this.client.query({
      query: `SELECT
                fingerprint,
                type,
                argMax(message, ts) AS message,
                count() AS count,
                uniqExact(sessionId) AS sessions,
                min(ts) AS firstSeen,
                max(ts) AS lastSeen,
                groupUniqArray(release) AS releases,
                argMinIf(release, ts, release != '') AS firstSeenRelease
              FROM error_events
              WHERE apikey = {apikey:String} AND fingerprint != '' AND ts >= {since:DateTime}
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
    // apikey/release 必须查回透传：符号化按 (apikey, release) 匹配工件
    const rs = await this.client.query({
      query: `SELECT apikey, release, sessionId, page, viewId, stack_frames, breadcrumbs,
                     message AS errorMessage, errorName, errorLevel, componentName, http, type
              FROM error_events
              WHERE apikey = {apikey:String} AND fingerprint = {fp:String}
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
      stack_frames: string
      breadcrumbs: string
      errorMessage: string
      errorName: string
      errorLevel: string
      componentName: string
      http: string
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
        name: row.errorName || undefined,
        level: row.errorLevel || undefined,
        fingerprint,
        componentName: row.componentName || undefined,
        stackFrames: JSON.parse(row.stack_frames || '[]'),
        http: row.http ? JSON.parse(row.http) : undefined,
      },
      breadcrumbs: JSON.parse(row.breadcrumbs || '[]'),
    }
  }

  async performanceQuantiles(
    apikey: string,
    metric: string,
    sinceMs: number
  ): Promise<PerfQuantiles> {
    const since = toClickHouseDateTime(new Date(Date.now() - sinceMs))
    const rs = await this.client.query({
      query: `SELECT
                count() AS count,
                quantileTDigest(0.5)(metric_value) AS p50,
                quantileTDigest(0.75)(metric_value) AS p75,
                quantileTDigest(0.95)(metric_value) AS p95
              FROM perf_events
              WHERE apikey = {apikey:String} AND metric_name = {metric:String} AND ts >= {since:DateTime}`,
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

  /** 行为明细全列查回（P2 明细完整性：PV 来源/track 属性/停留时长与 Memory 等价） */
  async recentBehaviors(apikey: string, limit: number): Promise<Array<Record<string, unknown>>> {
    const rs = await this.client.query({
      query: `SELECT behavior_type, name, props, url, load_type, referrer_host,
                     utm_source, utm_medium, utm_campaign, selector, dwell_ms, from_source,
                     ts, sessionId, page
              FROM behavior_events
              WHERE apikey = {apikey:String}
              ORDER BY ts DESC LIMIT {limit:UInt32}`,
      query_params: { apikey, limit },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<Record<string, string>>()
    return rows.map((r) => ({
      behaviorType: r.behavior_type,
      type: r.behavior_type,
      ts: new Date(r.ts.replace(' ', 'T') + 'Z').toISOString(),
      sessionId: r.sessionId,
      page: r.page,
      ...behaviorDetailFields({
        name: r.name,
        props: r.props ? JSON.parse(r.props) : undefined,
        url: r.url,
        loadType: r.load_type,
        referrerHost: r.referrer_host,
        utmSource: r.utm_source,
        utmMedium: r.utm_medium,
        utmCampaign: r.utm_campaign,
        selector: r.selector,
        activeMs: Number(r.dwell_ms) > 0 ? Number(r.dwell_ms) : undefined,
        from: r.from_source,
      }),
    }))
  }

  /** 错误趋势：小时桶（零桶不补——前端补零；与 Memory 实现的窗口语义一致由调用方约定） */
  async errorTrend(apikey: string, hours: number): Promise<TrendBucket[]> {
    const since = toClickHouseDateTime(new Date(Date.now() - hours * 3600_000))
    const rs = await this.client.query({
      query: `SELECT toStartOfHour(ts) AS hour, count() AS n
              FROM error_events
              WHERE apikey = {apikey:String} AND ts >= {since:DateTime}
              GROUP BY hour ORDER BY hour`,
      query_params: { apikey, since },
      format: 'JSONEachRow',
    })
    const rows = (await rs.json()) as Array<{ hour: string; n: string }>
    // 零填充完整窗口（与 Memory 现算语义一致）
    const byHour = new Map(rows.map((r) => [r.hour, Number(r.n)]))
    const out: TrendBucket[] = []
    const start = Date.now() - hours * 3600_000
    for (let t = start; t <= Date.now(); t += 3600_000) {
      const key = toClickHouseDateTime(new Date(t))
      out.push({ hour: new Date(t).toISOString(), count: byHour.get(key) ?? 0 })
    }
    return out
  }

  /** 页面维度 Vitals 分位（单查询 4 指标条件分位；TDigest 跳过 NULL） */
  async performanceByPage(apikey: string, sinceMs: number): Promise<PagePerf[]> {
    const since = toClickHouseDateTime(new Date(Date.now() - sinceMs))
    const rs = await this.client.query({
      query: `SELECT page,
                count() AS samples,
                quantileTDigest(0.75)(if(metric_name = 'largest-contentful-paint', metric_value, NULL)) AS lcp,
                quantileTDigest(0.75)(if(metric_name = 'cumulative-layout-shift', metric_value, NULL)) AS cls,
                quantileTDigest(0.75)(if(metric_name = 'interaction-to-next-paint', metric_value, NULL)) AS inp,
                quantileTDigest(0.75)(if(metric_name = 'first-contentful-paint', metric_value, NULL)) AS fcp
              FROM perf_events
              WHERE apikey = {apikey:String} AND ts >= {since:DateTime}
              GROUP BY page
              ORDER BY samples DESC`,
      query_params: { apikey, since },
      format: 'JSONEachRow',
    })
    const rows = (await rs.json()) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      page: String(r.page),
      samples: Number(r.samples),
      lcpP75: r.lcp === null ? null : Number(r.lcp),
      clsP75: r.cls === null ? null : Number(r.cls),
      inpP75: r.inp === null ? null : Number(r.inp),
      fcpP75: r.fcp === null ? null : Number(r.fcp),
    }))
  }

  async errorCountsByFingerprint(
    apikey: string,
    fingerprints: string[]
  ): Promise<Map<string, number>> {
    if (fingerprints.length === 0) return new Map()
    const rs = await this.client.query({
      query: `SELECT fingerprint, count() AS n
              FROM error_events
              WHERE apikey = {apikey:String} AND fingerprint IN {fps:Array(String)}
              GROUP BY fingerprint`,
      query_params: { apikey, fps: fingerprints },
      format: 'JSONEachRow',
    })
    const rows = (await rs.json()) as Array<{ fingerprint: string; n: number }>
    return new Map(rows.map((r) => [r.fingerprint, Number(r.n)]))
  }
}
