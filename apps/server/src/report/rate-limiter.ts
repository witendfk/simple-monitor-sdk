/**
 * 限流契约 + 双实现（内存固定窗口 / Redis INCR+EXPIRE）。
 * 粒度：apikey 每分钟信封数（防单项目打爆接入层）。
 */
import { Injectable } from '@nestjs/common'
import Redis from 'ioredis'

export interface RateLimitResult {
  allowed: boolean
  /** 被限流时返回建议等待秒数（Retry-After 头） */
  retryAfterSec: number
}

export const RATE_LIMITER_TOKEN = 'RATE_LIMITER'

export interface IRateLimiter {
  check(apikey: string, limitPerMin: number): Promise<RateLimitResult>
}

/** 固定窗口（内存）：分钟窗口内计数，窗口翻转重置 */
@Injectable()
export class MemoryRateLimiter implements IRateLimiter {
  private windows = new Map<string, { windowStart: number; count: number }>()

  async check(apikey: string, limitPerMin: number): Promise<RateLimitResult> {
    const now = Date.now()
    const windowStart = Math.floor(now / 60_000) * 60_000
    const win = this.windows.get(apikey)
    if (!win || win.windowStart !== windowStart) {
      this.windows.set(apikey, { windowStart, count: 1 })
      return { allowed: true, retryAfterSec: 0 }
    }
    win.count += 1
    if (win.count > limitPerMin) {
      const resetAt = windowStart + 60_000
      return { allowed: false, retryAfterSec: Math.ceil((resetAt - now) / 1000) }
    }
    return { allowed: true, retryAfterSec: 0 }
  }
}

/** Redis INCR + EXPIRE（多实例部署时限流计数共享） */
@Injectable()
export class RedisRateLimiter implements IRateLimiter {
  private readonly redis: Redis

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 })
  }

  async check(apikey: string, limitPerMin: number): Promise<RateLimitResult> {
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000
    const key = `ratelimit:${apikey}:${windowStart}`
    const count = await this.redis.incr(key)
    if (count === 1) {
      await this.redis.expire(key, 60)
    }
    if (count > limitPerMin) {
      const ttl = await this.redis.ttl(key)
      return { allowed: false, retryAfterSec: ttl > 0 ? ttl : 60 }
    }
    return { allowed: true, retryAfterSec: 0 }
  }
}
