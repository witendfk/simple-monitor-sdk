/**
 * 告警引擎：定时评估全部启用规则 → 触发即投递 webhook（带冷却防轰炸）。
 *
 * 设计（总纲 §6.2 步骤 8）：
 *  - 突增规则：近 windowMin 错误数 > max(minCount, 基线均值 × multiplier)
 *  - 阈值规则：metric 的 P75 持续超阈（单窗口命中即报，冷却承担"持续"语义）
 *  - 冷却：ruleId → lastFiredAt，窗口内跳过（投递失败不进入冷却，下轮重试）
 *  - 异步纪律：评估循环是 setInterval 驱动的 fire-and-forget，全链就地消化
 */
import { Injectable, Logger } from '@nestjs/common'
import type { IEventStorage } from '../storage/event-storage'
import { AlertRuleStore } from './rule-store'
import {
  isSpike,
  isThresholdBreached,
  type AlertFire,
  type AlertRule,
  type ErrorSpikeConfig,
  type PerfThresholdConfig,
} from './alert.types'

/** webhook 投递契约（fetch 实现 / 测试 mock） */
export interface WebhookSender {
  send(url: string, payload: Record<string, unknown>): Promise<void>
}

export class FetchWebhookSender implements WebhookSender {
  async send(url: string, payload: Record<string, unknown>): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      throw new Error(`webhook responded ${res.status}`)
    }
  }
}

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000

@Injectable()
export class AlertEngine {
  private readonly logger = new Logger(AlertEngine.name)
  private timer: ReturnType<typeof setInterval> | null = null
  private evaluating = false
  private readonly cooldown = new Map<string, number>()
  private running = false

  constructor(
    private readonly storage: IEventStorage,
    private readonly store: AlertRuleStore,
    private readonly sender: WebhookSender,
    private readonly checkIntervalMs: number = DEFAULT_CHECK_INTERVAL_MS
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => {
      void this.evaluateAll()
    }, this.checkIntervalMs)
    // 启动后先评估一轮（定时器首触发要等一个周期）
    void this.evaluateAll()
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 评估全部启用规则；单规则异常不影响其他规则（错误隔离纪律） */
  async evaluateAll(now = Date.now()): Promise<AlertFire[]> {
    if (!this.running || this.evaluating) return []
    this.evaluating = true
    const fires: AlertFire[] = []
    try {
      for (const rule of this.store.list()) {
        if (!rule.enabled) continue
        if (!this.cooldownPassed(rule, now)) continue
        try {
          const fire = await this.evaluateRule(rule, now)
          if (fire) {
            fires.push(fire)
          }
        } catch (error) {
          this.logger.warn(`rule ${rule.id} evaluation failed: ${String(error)}`)
        }
      }
    } finally {
      this.evaluating = false
    }
    return fires
  }

  private cooldownPassed(rule: AlertRule, now: number): boolean {
    const last = this.cooldown.get(rule.id)
    return last === undefined || now - last >= rule.cooldownMinutes * 60_000
  }

  private async evaluateRule(rule: AlertRule, now: number): Promise<AlertFire | null> {
    if (rule.type === 'error_spike') {
      const cfg = rule.config as ErrorSpikeConfig
      const windowMs = cfg.windowMinutes * 60_000
      const recent = await this.storage.overview(windowMs)
      const baseline = await this.storage.overview(cfg.baselineMinutes * 60_000)
      const baselineAvgPerWindow =
        baseline.errorCount / Math.max(1, cfg.baselineMinutes / cfg.windowMinutes)
      if (!isSpike({ recentErrorCount: recent.errorCount, baselineAvgPerWindow }, cfg)) {
        return null
      }
      const fire = this.buildFire(rule, now, {
        message: `错误突增：近 ${cfg.windowMinutes} 分钟 ${recent.errorCount} 条（基线均值 ${baselineAvgPerWindow.toFixed(1)}，阈值 ${Math.max(cfg.minCount, baselineAvgPerWindow * cfg.multiplier).toFixed(0)}）`,
        context: {
          recentErrorCount: recent.errorCount,
          baselineAvgPerWindow: Number(baselineAvgPerWindow.toFixed(2)),
          totalEvents: recent.totalEvents,
        },
      })
      // 投递成功才计入 fires（失败不进冷却，下一评估周期自然重试）
      return (await this.fire(rule, fire)) ? fire : null
    }

    const cfg = rule.config as PerfThresholdConfig
    const quantiles = await this.storage.performanceQuantiles(
      cfg.metric,
      cfg.windowMinutes * 60_000
    )
    if (!isThresholdBreached(quantiles.p75, cfg)) {
      return null
    }
    const fire = this.buildFire(rule, now, {
      message: `${cfg.metric} P75 超阈：${quantiles.p75} ≥ ${cfg.threshold}（样本 ${quantiles.count}）`,
      context: { p75: quantiles.p75, threshold: cfg.threshold, count: quantiles.count },
    })
    return (await this.fire(rule, fire)) ? fire : null
  }

  private buildFire(
    rule: AlertRule,
    now: number,
    payload: { message: string; context: Record<string, unknown> }
  ): AlertFire {
    return {
      id: `fire-${now.toString(36)}-${rule.id}`,
      ruleId: rule.id,
      ruleName: rule.name,
      apikey: rule.apikey,
      firedAt: new Date(now).toISOString(),
      message: payload.message,
      context: payload.context,
    }
  }

  /** 投递：成功返回 true 并进入冷却；失败就地消化（下轮重试） */
  private async fire(rule: AlertRule, fire: AlertFire): Promise<boolean> {
    try {
      await this.sender.send(rule.webhookUrl, {
        msg_type: 'text',
        content: {
          text: `[Simple Monitor] ${fire.ruleName}\n${fire.message}\n项目 ${fire.apikey} · ${fire.firedAt}`,
        },
        // 通用字段：卡片类 webhook（飞书插件/自建消费端）可取结构化数据
        alert: { ruleId: fire.ruleId, ruleName: fire.ruleName, ...fire.context },
      })
      this.cooldown.set(rule.id, Date.now())
      this.store.recordFire(fire)
      this.logger.log(`alert fired: ${fire.ruleName} — ${fire.message}`)
      return true
    } catch (error) {
      this.logger.warn(`webhook delivery failed for rule ${rule.id}: ${String(error)}`)
      return false
    }
  }
}
