/**
 * PG 元数据域集成测试（M7.5 P1）：PG_URL 在位才跑（本地 docker / CI 无 docker 自动跳过）。
 * 验证点：双密钥项目种子幂等 / 规则与触发记录持久化 / sourcemap 工件跨重启存活 /
 * Issue upsert 重放幂等（重试重放不错计）+ count 对账覆写。
 * 用独立的测试项目 key，跑完清理本测试数据。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { PgProjectStore } from '../src/storage/pg/pg-project.store'
import { PgAlertRuleStore } from '../src/storage/pg/pg-alert-rule.store'
import { PgSourcemapArtifactStore } from '../src/storage/pg/pg-sourcemap-artifact.store'
import { PgIssueStore } from '../src/storage/pg/pg-issue.store'
import { hashSecretKey } from '../src/projects/projects.service'
import type { AlertFire, AlertRule } from '../src/alert/alert.types'

const PG_URL = process.env.PG_URL ?? ''
const KEY = `pgtest-${Date.now().toString(36)}`

describe.skipIf(!PG_URL)('PG 元数据域（M7.5 P1）', () => {
  let pool: Pool
  let projectId: number

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL })
    await pool.query(
      `INSERT INTO projects (public_key, secret_key_hash, name, rate_limit_per_min)
       VALUES ($1, $2, 'pgtest', 500)
       ON CONFLICT (public_key) DO UPDATE SET name = EXCLUDED.name`,
      [KEY, hashSecretKey('secret-for-test')]
    )
    const r = await pool.query('SELECT id FROM projects WHERE public_key = $1', [KEY])
    projectId = Number(r.rows[0].id)
  })

  afterAll(async () => {
    await pool.query('DELETE FROM projects WHERE public_key = $1', [KEY])
    await pool.end()
  })

  it('项目双密钥：exists/get 读回 public_key 与 secret_key_hash', async () => {
    const store = new PgProjectStore(pool)
    await expect(store.exists(KEY)).resolves.toBe(true)
    await expect(store.exists('ghost-key')).resolves.toBe(false)
    const p = await store.get(KEY)
    expect(p?.name).toBe('pgtest')
    expect(p?.rateLimitPerMin).toBe(500)
    expect(p?.secretKeyHash).toBe(hashSecretKey('secret-for-test'))
  })

  it('ensureProjects 幂等：重复种子不重复建行，字段以最新为准', async () => {
    const store = new PgProjectStore(pool)
    await store.ensureProjects([
      { apikey: KEY, name: 'pgtest-v2', rateLimitPerMin: 700, secretKeyHash: 'h2' },
    ])
    await store.ensureProjects([
      { apikey: KEY, name: 'pgtest-v2', rateLimitPerMin: 700, secretKeyHash: 'h2' },
    ])
    const rows = await pool.query('SELECT * FROM projects WHERE public_key = $1', [KEY])
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0].name).toBe('pgtest-v2')
    expect(rows.rows[0].rate_limit_per_min).toBe(700)
  })

  it('告警规则 CRUD + 触发记录持久化与项目隔离', async () => {
    const store = new PgAlertRuleStore(pool)
    const rule: Omit<AlertRule, 'id'> = {
      apikey: KEY,
      type: 'error_spike',
      name: 'PG 规则',
      webhookUrl: 'https://hooks.example.com/pg',
      cooldownMinutes: 10,
      enabled: true,
      config: { windowMinutes: 15, baselineMinutes: 360, minCount: 20, multiplier: 3 },
    }
    const created = await store.create(rule)
    expect(created.id).toMatch(/^rule-/)
    await expect(store.get(created.id)).resolves.toMatchObject({ name: 'PG 规则' })
    await expect(store.list(KEY)).resolves.toHaveLength(1)

    const fire: AlertFire = {
      id: 'fire-pgtest-1',
      ruleId: created.id,
      ruleName: 'PG 规则',
      apikey: KEY,
      firedAt: new Date().toISOString(),
      message: 'spike',
      context: { recentErrorCount: 50 },
    }
    await store.recordFire(fire)
    const fires = await store.listFires(KEY)
    expect(fires).toHaveLength(1)
    expect(fires[0].context).toMatchObject({ recentErrorCount: 50 })

    await expect(store.delete(created.id)).resolves.toBe(true)
    await expect(store.list(KEY)).resolves.toHaveLength(0)
    // 规则删除 CASCADE 触发历史（P1 取舍，见 store 注释）
    await expect(store.listFires(KEY)).resolves.toHaveLength(0)
  })

  it('sourcemap 工件：upsert 覆盖同键、按 release 列举', async () => {
    const store = new PgSourcemapArtifactStore(pool)
    const artifact = {
      apikey: KEY,
      release: 'v9.9.9',
      url: '/assets/app.js',
      mapJson: '{"version":3,"mappings":"AAAA"}',
      uploadedAt: Date.now(),
    }
    await store.upsert(artifact)
    await store.upsert({ ...artifact, mapJson: '{"version":3,"mappings":"BBBB"}' })
    const list = await store.listByRelease(KEY, 'v9.9.9')
    expect(list).toHaveLength(1)
    expect(list[0].mapJson).toContain('BBBB')
    expect(await store.count()).toBeGreaterThan(0)
    await pool.query(
      `DELETE FROM sourcemap_artifacts WHERE project_id = $1 AND release = 'v9.9.9'`,
      [projectId]
    )
  })

  it('Issue 状态机：首见写入 → 重放幂等（不错计）→ 对账覆写 count', async () => {
    const store = new PgIssueStore(pool)
    const ts1 = new Date('2026-10-12T01:00:00Z')
    const ts2 = new Date('2026-10-12T02:00:00Z')
    const issues = [
      { fingerprint: 'fp-pgtest-1', ts: ts1, release: 'v1.0.0' },
      { fingerprint: 'fp-pgtest-2', ts: ts2 },
    ]
    await store.upsertIssues(KEY, issues)
    // 重放：同批次 + 更早时间戳再 upsert——first_seen 不回退、不产生第二行、无计数副作用
    await store.upsertIssues(KEY, [
      { fingerprint: 'fp-pgtest-1', ts: ts1 },
      { fingerprint: 'fp-pgtest-2', ts: ts2, release: 'v0.9.0' },
    ])
    const rows = await pool.query(
      `SELECT fingerprint, status, first_seen, last_seen, first_release, event_count
       FROM issues WHERE project_id = $1 ORDER BY fingerprint`,
      [projectId]
    )
    expect(rows.rowCount).toBe(2)
    const first = rows.rows.find((r) => r.fingerprint === 'fp-pgtest-1')
    expect(new Date(first.first_seen).toISOString()).toBe(ts1.toISOString())
    expect(first.first_release).toBe('v1.0.0')
    expect(first.status).toBe('open')
    expect(Number(first.event_count)).toBe(0)

    // 对账：CH 事实源覆写 count（非增量——重放安全的关键）
    await store.reconcileCounts(KEY, [
      { fingerprint: 'fp-pgtest-1', count: 42 },
      { fingerprint: 'fp-pgtest-1', count: 42 },
    ])
    const after = await pool.query(
      'SELECT event_count FROM issues WHERE project_id = $1 AND fingerprint = $2',
      [projectId, 'fp-pgtest-1']
    )
    expect(Number(after.rows[0].event_count)).toBe(42)
  })
})
