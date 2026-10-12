/**
 * Issue 状态机存储（M7.5 P1）：M5「查询时聚合」的退出——
 * first_seen / last_seen / status / first_release 持久化，fingerprint UNIQUE。
 *
 * 失败恢复设计（CURRENT §3.1 P1 验收）：
 *  - upsertIssues 幂等（first/last 用 LEAST/GREATEST，无计数增量）——ingest 重试重放
 *    无副作用，可与 CH 写入以任意顺序重排；
 *  - event_count 不在 upsert 里累加（重放会双计），由 reconcileCounts 从 CH（事件
 *    事实源）对账覆写，best-effort 失败仅告警、下批自然补齐——「不永久错计」；
 *  - CH 重复消费的重复计数为已知边界，P4 稳定事件 ID 修复（先 SPEC 后 SETNX 纪律）。
 */

export const ISSUE_STORE_TOKEN = 'ISSUE_STORE'

export interface IssueUpsert {
  fingerprint: string
  ts: Date
  release?: string
}

export interface IIssueStore {
  upsertIssues(apikey: string, issues: IssueUpsert[]): Promise<void>
  /** 从事件事实源对账计数（覆写语义，非增量） */
  reconcileCounts(
    apikey: string,
    counts: Array<{ fingerprint: string; count: number }>
  ): Promise<void>
}

export interface IssueRow {
  fingerprint: string
  status: 'open' | 'resolved' | 'ignored'
  firstSeen: string
  lastSeen: string
  firstRelease?: string
  eventCount: number
}

export class MemoryIssueStore implements IIssueStore {
  /** key: apikey|fingerprint */
  private readonly issues = new Map<string, IssueRow>()

  async upsertIssues(apikey: string, issues: IssueUpsert[]): Promise<void> {
    for (const it of issues) {
      const key = `${apikey}|${it.fingerprint}`
      const existing = this.issues.get(key)
      if (!existing) {
        this.issues.set(key, {
          fingerprint: it.fingerprint,
          status: 'open',
          firstSeen: it.ts.toISOString(),
          lastSeen: it.ts.toISOString(),
          ...(it.release ? { firstRelease: it.release } : {}),
          eventCount: 0,
        })
        continue
      }
      existing.firstSeen =
        existing.firstSeen < it.ts.toISOString() ? existing.firstSeen : it.ts.toISOString()
      existing.lastSeen =
        existing.lastSeen > it.ts.toISOString() ? existing.lastSeen : it.ts.toISOString()
      existing.firstRelease = existing.firstRelease ?? it.release
    }
  }

  async reconcileCounts(
    apikey: string,
    counts: Array<{ fingerprint: string; count: number }>
  ): Promise<void> {
    for (const { fingerprint, count } of counts) {
      const row = this.issues.get(`${apikey}|${fingerprint}`)
      if (row) row.eventCount = count
    }
  }

  /** 测试观测 */
  list(apikey?: string): IssueRow[] {
    const all = [...this.issues.entries()]
      .filter(([k]) => !apikey || k.startsWith(`${apikey}|`))
      .map(([, v]) => v)
    return all
  }
}
