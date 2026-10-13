/**
 * 用户存储（M7.5 P3 权限分离）：登录身份 + 用户↔项目绑定。
 * DIP 双实现——MemoryUserStore（零依赖形态）/ PgUserStore（storage/pg/，users +
 * project_members 表）。密码校验内聚在 store（复用 password.ts 的 scrypt 校验）。
 * 边界（如实声明）：单管理员全局视图——用户绑定首个项目作为管理范围，
 * 多成员/多角色权限细化属剪裁线（PRD §7），不在 P3 范围。
 */
import { Injectable } from '@nestjs/common'
import { verifyPassword } from './password'

export const USER_STORE_TOKEN = 'USER_STORE'

export interface IUserStore {
  /** 幂等种子：不存在则创建（已存在不覆盖密码——种子重跑不重置凭证） */
  ensureUser(email: string, passwordHash: string): Promise<void>
  /** 登录校验：成功返回用户 id；无此用户/密码错返回 null */
  verifyLogin(email: string, password: string): Promise<number | null>
  /** 用户邮箱（/auth/me 展示用） */
  getEmail(uid: number): Promise<string | null>
  /** 用户的管理范围项目（public_key）——取首个成员绑定；无绑定返回 null */
  getManagedProjectApiKey(uid: number): Promise<string | null>
  /** 种子后的成员绑定（幂等）：绑定用户与项目（项目不存在时静默跳过） */
  bindProjectByEmail(email: string, apikey: string): Promise<void>
}

@Injectable()
export class MemoryUserStore implements IUserStore {
  private seq = 0
  private readonly byEmail = new Map<string, { id: number; passwordHash: string }>()
  private readonly membership = new Map<number, string>()

  constructor(private readonly fallbackProjectApiKey: string) {}

  async ensureUser(email: string, passwordHash: string): Promise<void> {
    if (!this.byEmail.has(email)) {
      this.byEmail.set(email, { id: ++this.seq, passwordHash })
    }
  }

  async verifyLogin(email: string, password: string): Promise<number | null> {
    const user = this.byEmail.get(email)
    if (!user || !verifyPassword(password, user.passwordHash)) return null
    return user.id
  }

  async getEmail(uid: number): Promise<string | null> {
    for (const [email, u] of this.byEmail) {
      if (u.id === uid) return email
    }
    return null
  }

  async getManagedProjectApiKey(uid: number): Promise<string | null> {
    return this.membership.get(uid) ?? this.fallbackProjectApiKey
  }

  async bindProjectByEmail(email: string, apikey: string): Promise<void> {
    const user = this.byEmail.get(email)
    if (user) this.membership.set(user.id, apikey)
  }
}
