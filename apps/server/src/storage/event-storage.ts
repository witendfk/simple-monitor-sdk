/**
 * 存储契约（DIP）：ingest 只面向 IEventStorage 编程。
 *
 * 查询粒度按看板需要定义（overview / 错误组 / 性能分位），
 * Memory 实现现算，ClickHouse 实现下推 SQL——接口稳定，实现可替换。
 */
import type { NormalizedEvent } from '../ingest/normalize'

export interface ErrorGroup {
  fingerprint: string
  type: string
  /** 组内样本 message（最新一条） */
  message: string
  count: number
  affectedSessions: number
  firstSeen: string
  lastSeen: string
  /** 见过的发版集合（发版对比视图） */
  releases: string[]
  /** 最早出现的发版（= 查询 release 时即「新错误回归」标记） */
  firstSeenRelease?: string
  /** 保留一条完整样本（含堆栈/面包屑）供详情页 */
  sample: NormalizedEvent
}

export interface OverviewStats {
  since: string
  until: string
  totalEvents: number
  errorCount: number
  perfCount: number
  sessionCount: number
  topErrors: Array<{ fingerprint: string; type: string; message: string; count: number }>
}

export interface PerfQuantiles {
  metric: string
  count: number
  p50: number | null
  p75: number | null
  p95: number | null
}

export const STORAGE_TOKEN = 'STORAGE'

/**
 * 查询一律带 apikey（总纲 §3.7 P0-4）：跨项目数据隔离是存储层的职责，
 * controller 从鉴权头透传，实现方必须过滤——漏过滤 = IDOR。
 */
export interface IEventStorage {
  /** 批量落库（ingest 调用） */
  saveBatch(events: NormalizedEvent[]): Promise<void>
  overview(apikey: string, sinceMs: number): Promise<OverviewStats>
  errorGroups(apikey: string, limit: number, sinceMs?: number): Promise<ErrorGroup[]>
  errorDetail(apikey: string, fingerprint: string): Promise<NormalizedEvent | null>
  performanceQuantiles(apikey: string, metric: string, sinceMs: number): Promise<PerfQuantiles>
  /** 最近行为事件（M7 通道冒烟 / M9 事件浏览器雏形） */
  recentBehaviors(apikey: string, limit: number): Promise<Array<Record<string, unknown>>>
}
