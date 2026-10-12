/**
 * Issue 状态机 PG 实现（M7.5 P1）：issues 表（UNIQUE(project_id, fingerprint)）。
 * upsert 全幂等：first_seen/last_seen 走 LEAST/GREATEST、first_release 只补缺、
 * status 不动（状态流转归管理 API，M8）、event_count 不在此累加（对账覆写，见
 * issue-store.ts 的失败恢复设计）。
 *
 * SQL 注记：VALUES 子查询里的 timestamptz / bigint 参数必须显式 cast——
 * VALUES 列类型无法从 UPDATE/INSERT 目标推断，参数默认落 text 会导致
 * 「column is of type timestamptz but expression is of type text」。
 */
import type { Pool } from 'pg'
import type { IIssueStore, IssueUpsert } from '../issue-store'

export class PgIssueStore implements IIssueStore {
  constructor(private readonly pool: Pool) {}

  async upsertIssues(apikey: string, issues: IssueUpsert[]): Promise<void> {
    if (issues.length === 0) return
    // $1 = apikey（JOIN 解析 project_id）；每条 issue 4 参：fp / first / last / release
    const values: unknown[] = [apikey]
    const tuples = issues
      .map((it, i) => {
        const b = i * 4 + 2
        values.push(it.fingerprint, it.ts, it.ts, it.release ?? null)
        return `($${b}, $${b + 1}::timestamptz, $${b + 2}::timestamptz, $${b + 3})`
      })
      .join(', ')
    await this.pool.query(
      `INSERT INTO issues (project_id, fingerprint, status, first_seen, last_seen, first_release, event_count)
       SELECT p.id, v.fingerprint, 'open', v.first_seen, v.last_seen, v.first_release, 0
       FROM (VALUES ${tuples}) AS v(fingerprint, first_seen, last_seen, first_release)
       JOIN projects p ON p.public_key = $1
       ON CONFLICT (project_id, fingerprint) DO UPDATE
       SET first_seen = LEAST(issues.first_seen, EXCLUDED.first_seen),
           last_seen = GREATEST(issues.last_seen, EXCLUDED.last_seen),
           first_release = COALESCE(issues.first_release, EXCLUDED.first_release)`,
      values
    )
  }

  async reconcileCounts(
    apikey: string,
    counts: Array<{ fingerprint: string; count: number }>
  ): Promise<void> {
    if (counts.length === 0) return
    const values: unknown[] = [apikey]
    const tuples = counts
      .map((c, i) => {
        const b = i * 2 + 2
        values.push(c.fingerprint, c.count)
        return `($${b}, $${b + 1}::bigint)`
      })
      .join(', ')
    await this.pool.query(
      `UPDATE issues i SET event_count = v.count
       FROM (VALUES ${tuples}) AS v(fingerprint, count)
       JOIN projects p ON p.public_key = $1
       WHERE i.project_id = p.id AND i.fingerprint = v.fingerprint`,
      values
    )
  }
}
