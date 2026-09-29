/**
 * 告警规则 CRUD + 触发记录查询（看板告警页数据源）
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common'
import { z } from 'zod'
import { AlertRuleStore } from './rule-store'
import type { AlertRule } from './alert.types'

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
  apikey: z.string().min(1),
  type: z.enum(['error_spike', 'perf_threshold']),
  name: z.string().min(1).max(100),
  webhookUrl: z.string().url(),
  cooldownMinutes: z.number().int().min(1).max(1440).default(15),
  enabled: z.boolean().default(true),
  config: z.unknown(),
})

/** 按规则类型收敛 config 形状（未通过即 404/405 语义由响应层处理） */
function normalizeRule(input: z.infer<typeof CreateRuleSchema>): Omit<AlertRule, 'id'> {
  const config =
    input.type === 'error_spike'
      ? SpikeConfigSchema.parse(input.config)
      : ThresholdConfigSchema.parse(input.config)
  return { ...input, config }
}

@Controller('api/alert-rules')
export class AlertRulesController {
  /** class 型参数显式 @Inject（vitest esbuild 无 design:paramTypes 元数据——项目必查项） */
  constructor(@Inject(AlertRuleStore) private readonly store: AlertRuleStore) {}

  @Get()
  list(@Query('apikey') apikey?: string): AlertRule[] {
    return this.store.list(apikey)
  }

  @Post()
  create(@Body() body: unknown): AlertRule {
    const parsed = CreateRuleSchema.safeParse(body)
    if (!parsed.success) {
      throw new NotFoundException({ error: 'invalid alert rule', issues: parsed.error.issues })
    }
    return this.store.create(normalizeRule(parsed.data))
  }

  @Delete(':id')
  remove(@Param('id') id: string): { deleted: boolean } {
    const deleted = this.store.delete(id)
    if (!deleted) throw new NotFoundException({ error: 'rule not found' })
    return { deleted: true }
  }
}

@Controller('api/alert-fires')
export class AlertFiresController {
  constructor(@Inject(AlertRuleStore) private readonly store: AlertRuleStore) {}

  @Get()
  list(@Query('limit') limit?: string): ReturnType<AlertRuleStore['listFires']> {
    return this.store.listFires(Number(limit) || 50)
  }
}
