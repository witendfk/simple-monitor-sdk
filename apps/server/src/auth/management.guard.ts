/**
 * 管理鉴权（M7.5 P3 权限分离，替代 ApiKeyGuard）——双通道：
 *  1. 项目密钥（非交互：SourceMap CLI / CI）：x-api-key 头对 projects.secret_key_hash
 *     校验（sha256 + timingSafeEqual），req.apikey = 该项目 public_key；
 *  2. 会话 cookie（交互：dashboard 登录态）：HMAC 签名令牌校验，req.apikey =
 *     用户成员绑定的项目（单管理员边界，见 user.store.ts）。
 *
 * 公开上报 key（public_key）不再是 /api/** 的通行证——它只用于 /report/batch
 * 信封体鉴权。两通道都失败 → 401（显式密钥头不匹配直接拒绝，不降级试探）。
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import { PROJECTS_TOKEN } from '../report/report.controller'
import type { IProjectStore } from '../projects/projects.service'
import { USER_STORE_TOKEN, type IUserStore } from './user.store'
import { readCookie, verifySession, SESSION_COOKIE } from './session'
import { CONFIG_TOKEN, type ServerConfig } from '../config'

export const MANAGEMENT_GUARD_TOKEN = 'MANAGEMENT_GUARD'

/** Guard 写入：req.apikey 数据隔离键；req.authEmail 操作者标识（审计/展示） */
export interface AuthedRequest extends Request {
  apikey: string
  authEmail: string
}

/** class 型参数一律显式 @Inject（vitest esbuild 无 design:paramTypes 元数据） */
@Injectable()
export class ManagementGuard implements CanActivate {
  constructor(
    @Inject(PROJECTS_TOKEN) private readonly projects: IProjectStore,
    @Inject(USER_STORE_TOKEN) private readonly users: IUserStore,
    @Inject(CONFIG_TOKEN) private readonly config: ServerConfig
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>()
    const authed = req as AuthedRequest

    // 通道一：项目密钥（CLI/CI）
    const secret = req.header('x-api-key')
    if (secret) {
      const project = await this.projects.findBySecretKey(secret)
      if (!project) {
        throw new UnauthorizedException({ error: 'invalid credential' })
      }
      authed.apikey = project.apikey
      authed.authEmail = 'secret-key'
      return true
    }

    // 通道二：会话 cookie（dashboard 登录态）
    const token = readCookie(req, SESSION_COOKIE)
    if (token) {
      const uid = verifySession(token, this.config.sessionSecret ?? '')
      if (uid !== null) {
        const apikey = await this.users.getManagedProjectApiKey(uid)
        if (apikey && (await this.projects.exists(apikey))) {
          authed.apikey = apikey
          authed.authEmail = (await this.users.getEmail(uid)) ?? `uid:${uid}`
          return true
        }
      }
    }

    throw new UnauthorizedException({ error: 'authentication required' })
  }
}
