/**
 * 登录/登出/会话查询（M7.5 P3）：dashboard 交互式登录入口。
 * 暴力破解防护：同 email 连续失败 5 次锁 15 分钟（内存计数，进程级——
 * 多副本部署下各进程独立计数，边界见 server README）。
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { z } from 'zod'
import { CONFIG_TOKEN, type ServerConfig } from '../config'
import { USER_STORE_TOKEN, type IUserStore } from './user.store'
import {
  clearSessionCookieHeader,
  readCookie,
  sessionCookieHeader,
  signSession,
  verifySession,
  SESSION_COOKIE,
} from './session'
import { ManagementGuard } from './management.guard'

const LoginSchema = z.object({
  account: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
})

const MAX_FAILS = 5
const LOCK_MS = 15 * 60_000

@Controller('auth')
export class AuthController {
  /** 失败计数：key = account（登录接口无会话，按账号锁而非按 IP——防分布式撞库同一账号） */
  private readonly fails = new Map<string, { count: number; lockedUntil: number }>()

  constructor(
    @Inject(USER_STORE_TOKEN) private readonly users: IUserStore,
    @Inject(CONFIG_TOKEN) private readonly config: ServerConfig
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Req() req: Request, @Body() body: unknown): Promise<{ ok: true; account: string }> {
    const parsed = LoginSchema.safeParse(body)
    if (!parsed.success) {
      throw new UnauthorizedException({ error: 'invalid credentials' })
    }
    const { account, password } = parsed.data

    const lock = this.fails.get(account)
    if (lock && lock.lockedUntil > Date.now()) {
      throw new UnauthorizedException({ error: 'too many attempts, try later' })
    }

    const uid = await this.users.verifyLogin(account, password)
    if (uid === null) {
      const count = (lock?.count ?? 0) + 1
      this.fails.set(account, {
        count,
        lockedUntil: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0,
      })
      throw new UnauthorizedException({ error: 'invalid credentials' })
    }
    this.fails.delete(account)

    const token = signSession(uid, this.config.sessionSecret ?? '')
    req.res?.setHeader('Set-Cookie', sessionCookieHeader(token))
    return { ok: true, account }
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Req() req: Request): { ok: true } {
    // 无状态令牌：登出 = 清浏览器 cookie（令牌本体到 exp 前仍有效，见 session.ts 边界）
    req.res?.setHeader('Set-Cookie', clearSessionCookieHeader())
    return { ok: true }
  }

  @Get('me')
  @UseGuards(ManagementGuard)
  me(@Req() req: Request): { account: string; apikey: string } {
    const authed = req as Request & { apikey: string; authAccount: string }
    return { account: authed.authAccount, apikey: authed.apikey }
  }

  /** 会话令牌自检（无 guard：仅校验签名与过期，供前端区分「未登录」与「登录过期」） */
  @Get('session-check')
  sessionCheck(@Req() req: Request): { valid: boolean } {
    const token = readCookie(req, SESSION_COOKIE)
    const uid = token ? verifySession(token, this.config.sessionSecret ?? '') : null
    return { valid: uid !== null }
  }
}
