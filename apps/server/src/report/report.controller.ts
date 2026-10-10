/**
 * 上报接入端点：POST /report/batch
 *
 * 职责链（docs/ARCHITECTURE.md §1 接入链路）：raw body 解析 → 协议 zod 校验 → apikey 鉴权
 * → 限流 → 入队 → 立即 204（毫秒级返回，接入层不做任何重活——削峰的本质）。
 */
import { Body, Controller, Headers, HttpCode, Inject, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { TransportEnvelopeSchema, type TransportEnvelope } from '@simple-monitor/protocol'
import { ProjectsService } from '../projects/projects.service'

/** 显式注入 token（vitest esbuild 无 emitDecoratorMetadata，design-type DI 不可用） */
export const PROJECTS_TOKEN = 'PROJECTS'
import { QUEUE_TOKEN, type IEventQueue } from '../queue/event-queue'
import { RATE_LIMITER_TOKEN, type IRateLimiter } from './rate-limiter'

@Controller('report')
export class ReportController {
  constructor(
    @Inject(PROJECTS_TOKEN) private readonly projects: ProjectsService,
    @Inject(QUEUE_TOKEN) private readonly queue: IEventQueue,
    @Inject(RATE_LIMITER_TOKEN) private readonly rateLimiter: IRateLimiter
  ) {}

  @Post('batch')
  @HttpCode(204)
  async report(
    @Headers('origin') origin: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    /** raw body 由 main.ts 的 express.json({type: () => true}) 解析（兼容 beacon text/plain） */
    @Body() rawBody: unknown
  ): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
    res.setHeader('Access-Control-Allow-Credentials', 'true')

    // 1. 协议校验：形状不对直接 400（协议是两端契约，宽松=漂移）
    const parsed = TransportEnvelopeSchema.safeParse(rawBody)
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid envelope',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      })
      return
    }
    const envelope: TransportEnvelope = parsed.data

    // 2. 鉴权：未注册 apikey 直接 403
    if (!this.projects.exists(envelope.auth.apiKey)) {
      res.status(403).json({ error: 'unknown apikey' })
      return
    }

    // 3. 限流：超阈值 429 + Retry-After
    const project = this.projects.get(envelope.auth.apiKey)
    const limit = await this.rateLimiter.check(
      envelope.auth.apiKey,
      project?.rateLimitPerMin ?? 1000
    )
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec))
      res.status(429).json({ error: 'rate limited', retryAfterSec: limit.retryAfterSec })
      return
    }

    // 4. 入队即返回（存储/聚合全部异步，接入层零等待）
    await this.queue.enqueue({
      payload: JSON.stringify(envelope),
      enqueuedAt: Date.now(),
    })
  }
}
