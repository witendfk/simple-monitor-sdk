/**
 * 用户存储 PG 实现（M7.5 P3）：users 表（scrypt password_hash）+ project_members
 * 成员绑定。登录校验、成员范围解析全在 SQL 侧完成。
 */
import type { Pool } from 'pg'
import type { IUserStore } from '../../auth/user.store'
import { verifyPassword } from '../../auth/password'

export class PgUserStore implements IUserStore {
  constructor(private readonly pool: Pool) {}

  async ensureUser(email: string, passwordHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING`,
      [email, passwordHash]
    )
  }

  async verifyLogin(email: string, password: string): Promise<number | null> {
    const r = await this.pool.query(
      'SELECT id, password_hash FROM users WHERE email = $1 LIMIT 1',
      [email]
    )
    const row = r.rows[0]
    if (!row || !verifyPassword(password, row.password_hash)) return null
    return Number(row.id)
  }

  async getEmail(uid: number): Promise<string | null> {
    const r = await this.pool.query('SELECT email FROM users WHERE id = $1 LIMIT 1', [uid])
    return r.rows[0]?.email ?? null
  }

  async getManagedProjectApiKey(uid: number): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT p.public_key
       FROM project_members m JOIN projects p ON p.id = m.project_id
       WHERE m.user_id = $1
       ORDER BY p.id LIMIT 1`,
      [uid]
    )
    return r.rows[0]?.public_key ?? null
  }

  async bindProjectByEmail(email: string, apikey: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_members (project_id, user_id, role)
       SELECT p.id, u.id, 'owner'
       FROM projects p, users u
       WHERE p.public_key = $2 AND u.email = $1
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [email, apikey]
    )
  }
}
