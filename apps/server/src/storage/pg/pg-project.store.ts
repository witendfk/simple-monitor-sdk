/**
 * 项目注册表 PG 实现（M7.5 P1）：projects 表（public_key UNIQUE + secret_key_hash
 * 双密钥地基）。PROJECTS_JSON 环境种子经 ensureProjects 幂等写入（ON CONFLICT 更新），
 * 未配置种子且表为空时落一个 demo 项目保底（零依赖演示语义不丢）。
 */
import type { Pool } from 'pg'
import { hashSecretKey, type IProjectStore, type Project } from '../../projects/projects.service'

export class PgProjectStore implements IProjectStore {
  constructor(private readonly pool: Pool) {}

  async exists(apikey: string): Promise<boolean> {
    const r = await this.pool.query('SELECT 1 FROM projects WHERE public_key = $1 LIMIT 1', [
      apikey,
    ])
    return (r.rowCount ?? 0) > 0
  }

  async get(apikey: string): Promise<Project | undefined> {
    const r = await this.pool.query(
      `SELECT public_key, name, rate_limit_per_min, secret_key_hash
       FROM projects WHERE public_key = $1 LIMIT 1`,
      [apikey]
    )
    const row = r.rows[0]
    if (!row) return undefined
    return {
      apikey: row.public_key,
      name: row.name,
      rateLimitPerMin: Number(row.rate_limit_per_min),
      ...(row.secret_key_hash ? { secretKeyHash: row.secret_key_hash } : {}),
    }
  }

  async findBySecretKey(secret: string): Promise<Project | undefined> {
    // 哈希列等值查找：比较时序泄露不构成可利用侧信道（输入是摘要而非原文）
    const r = await this.pool.query(
      `SELECT public_key, name, rate_limit_per_min, secret_key_hash
       FROM projects WHERE secret_key_hash = $1 LIMIT 1`,
      [hashSecretKey(secret)]
    )
    const row = r.rows[0]
    if (!row) return undefined
    return {
      apikey: row.public_key,
      name: row.name,
      rateLimitPerMin: Number(row.rate_limit_per_min),
      ...(row.secret_key_hash ? { secretKeyHash: row.secret_key_hash } : {}),
    }
  }

  /** 幂等种子：PROJECTS_JSON → projects 表（name/限额/密钥哈希以最新种子为准） */
  async ensureProjects(projects: Project[]): Promise<void> {
    for (const p of projects) {
      await this.pool.query(
        `INSERT INTO projects (public_key, secret_key_hash, name, rate_limit_per_min)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (public_key) DO UPDATE
         SET name = EXCLUDED.name,
             rate_limit_per_min = EXCLUDED.rate_limit_per_min,
             secret_key_hash = EXCLUDED.secret_key_hash`,
        [p.apikey, p.secretKeyHash ?? null, p.name, p.rateLimitPerMin]
      )
    }
  }

  /** 种子为空且表为空 → demo 项目保底（对齐内存形态语义） */
  async ensureDemoFallback(): Promise<void> {
    const r = await this.pool.query('SELECT 1 FROM projects LIMIT 1')
    if ((r.rowCount ?? 0) === 0) {
      await this.ensureProjects([{ apikey: 'demo-key', name: 'demo', rateLimitPerMin: 1000 }])
    }
  }
}
