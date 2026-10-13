/**
 * 会话令牌（M7.5 P3）：HMAC-SHA256 签名的无状态令牌——
 * `base64(payload).hmac(payload)`，payload = { uid, exp }。
 * 无服务端会话表（PG sessions 免建），吊销语义 = exp 过期（7 天）+ 密钥轮换；
 * 令牌泄漏的缓解是 HttpOnly + SameSite=Lax cookie 与 HTTPS 部署前提（README 边界）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'

export const SESSION_COOKIE = 'sm_session'
export const SESSION_TTL_MS = 7 * 24 * 3600_000

export function signSession(uid: number, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ uid, exp: now + SESSION_TTL_MS })).toString(
    'base64url'
  )
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** 返回 uid；签名不符/过期/畸形一律 null（不抛出） */
export function verifySession(token: string, secret: string, now = Date.now()): number | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      uid?: unknown
      exp?: unknown
    }
    if (typeof data.uid !== 'number' || typeof data.exp !== 'number') return null
    if (data.exp < now) return null
    return data.uid
  } catch {
    return null
  }
}

/** 手动解析 Cookie 头（免 cookie-parser 依赖） */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim()
  }
  return undefined
}

/** 登录种子的 Set-Cookie 值（HttpOnly 防 XSS 读取；SameSite=Lax 防 CSRF 跨站携带） */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}
