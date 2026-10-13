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
 * 行为明细的规范输出形状（Memory 与 CH 两形态共用同一函数，equivalence 测试锁定）。
 * 输入是行为载荷的键值视图：Memory 直接传 payload，CH 从分表列回填同名键。
 * 停留时长统一输出 dwellMs（page_dwell.activeMs / expose.dwellMs 归一）。
 */
export function behaviorDetailFields(b: Record<string, unknown>): Record<string, unknown> {
  const str = (k: string): string | undefined =>
    typeof b[k] === 'string' && (b[k] as string) !== '' ? (b[k] as string) : undefined
  const activeMs = typeof b['activeMs'] === 'number' ? (b['activeMs'] as number) : undefined
  const dwellMs = typeof b['dwellMs'] === 'number' ? (b['dwellMs'] as number) : undefined
  const dwell = activeMs ?? dwellMs
  return {
    ...(str('name') ? { name: str('name') } : {}),
    ...(b['props'] !== undefined && b['props'] !== null ? { props: b['props'] } : {}),
    ...(str('url') ? { url: str('url') } : {}),
    ...(str('loadType') ? { loadType: str('loadType') } : {}),
    ...(str('referrerHost') ? { referrerHost: str('referrerHost') } : {}),
    ...(str('utmSource') ? { utmSource: str('utmSource') } : {}),
    ...(str('utmMedium') ? { utmMedium: str('utmMedium') } : {}),
    ...(str('utmCampaign') ? { utmCampaign: str('utmCampaign') } : {}),
    ...(str('selector') ? { selector: str('selector') } : {}),
    ...(dwell !== undefined && dwell > 0 ? { dwellMs: dwell } : {}),
    ...(str('from') ? { from: str('from') } : {}),
  }
}

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
  /** 指纹错误计数（M7.5 P1 Issue 对账的事实源：CH 为事件事实，PG 只存可变状态） */
  errorCountsByFingerprint(apikey: string, fingerprints: string[]): Promise<Map<string, number>>
}
