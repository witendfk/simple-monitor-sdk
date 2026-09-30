/**
 * 告警规则 CRUD + 触发记录查询（看板告警页数据源）
 *
 * 鉴权（总纲 §3.7 P0-3/P0-6）：ApiKeyGuard 校验 x-api-key；规则归属鉴权项目
 * （body.apikey 忽略，防代建）；删除校验属主；webhookUrl 白名单防 SSRF。
 */
import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { z } from 'zod'
import { CONFIG_TOKEN, type ServerConfig } from '../config'
import { ApiKeyGuard } from '../auth/api-key.guard'
import { AlertRuleStore } from './rule-store'
import { isSafeWebhookUrl } from './webhook-url'
import type { AlertRule } from './alert.types'

/** Guard 写入 req.apikey（见 api-key.guard.ts） */
type AuthedRequest = Request & { apikey: string }

const SpikeConfigSchema = z.object({
  windowMinutes: z.number().int().positive().max(1440).default(15),
  baselineMinutes: z.number().int().positive().max(10080).default(360),
  minCount: z.number().int().nonnegative().default(20),
  multiplier: z.number().positive().default(3),
})

const ThresholdConfigSchema = z.object({
  metric: z.string().min(1),
  threshold: z.number(),
  windowMinutes: z.number().int().positive().max(1440).default(60),
})

const CreateRuleSchema = z.object({
  type: z.enum(['error_spike', 'perf_threshold']),
  name: z.string().min(1).max(100),
  webhookUrl: z.string().min(1),
  cooldownMinutes: z.number().int().min(1).max(1440).default(15),
  enabled: z.boolean().default(true),
  config: z.unknown(),
})

/** 按规则类型收敛 config 形状；非法即 400（校验失败不该伪装成 404/500） */
function normalizeRule(
  input: z.infer<typeof CreateRuleSchema>,
  apikey: string
): Omit<AlertRule, 'id'> {
  const parsed =
    input.type === 'error_spike'
      ? SpikeConfigSchema.safeParse(input.config)
      : ThresholdConfigSchema.safeParse(input.config)
  if (!parsed.success) {
    throw new BadRequestException({
      error: 'invalid alert rule config',
      issues: parsed.error.issues,
    })
  }
  return {
    apikey,
    type: input.type,
    name: input.name,
    webhookUrl: input.webhookUrl,
    cooldownMinutes: input.cooldownMinutes,
    enabled: input.enabled,
    config: parsed.data,
  }
}

@Controller('api/alert-rules')
@UseGuards(ApiKeyGuard)
export class AlertRulesController {
  /** class 型参数显式 @Inject（vitest esbuild 无 design:paramTypes 元数据——项目必查项） */
  constructor(
    @Inject(AlertRuleStore) private readonly store: AlertRuleStore,
    @Inject(CONFIG_TOKEN) private readonly config: ServerConfig
  ) {}

  @Get()
  list(@Req() req: AuthedRequest): AlertRule[] {
    return this.store.list(req.apikey)
  }

  @Post()
  create(@Req() req: AuthedRequest, @Body() body: unknown): AlertRule {
    const parsed = CreateRuleSchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({ error: 'invalid alert rule', issues: parsed.error.issues })
    }
    if (!isSafeWebhookUrl(parsed.data.webhookUrl, this.config.webhookAllowPrivate)) {
      throw new BadRequestException({ error: 'webhookUrl must be a public http(s) URL' })
    }
    return this.store.create(normalizeRule(parsed.data, req.apikey))
  }

  @Delete(':id')
  remove(@Req() req: AuthedRequest, @Param('id') id: string): { deleted: boolean } {
    const rule = this.store.get(id)
    if (!rule || rule.apikey !== req.apikey) {
      throw new NotFoundException({ error: 'rule not found' })
    }
    this.store.delete(id)
    return { deleted: true }
  }
}

@Controller('api/alert-fires')
@UseGuards(ApiKeyGuard)
export class AlertFiresController {
  constructor(@Inject(AlertRuleStore) private readonly store: AlertRuleStore) {}

  @Get()
  list(
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string
  ): ReturnType<AlertRuleStore['listFires']> {
    return this.store.listFires(req.apikey, Number(limit) || 50)
  }
}
