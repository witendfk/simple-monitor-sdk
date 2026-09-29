/**
 * 规则存储 + 触发记录（内存实现；Postgres 持久化归 M4 遗留切片，接口已稳定）
 */
import { Injectable } from '@nestjs/common'
import type { AlertFire, AlertRule } from './alert.types'

const MAX_FIRES = 200

@Injectable()
export class AlertRuleStore {
  private rules = new Map<string, AlertRule>()
  private fires: AlertFire[] = []
  private seq = 0

  list(apikey?: string): AlertRule[] {
    const all = [...this.rules.values()]
    return apikey ? all.filter((r) => r.apikey === apikey) : all
  }

  create(rule: Omit<AlertRule, 'id'>): AlertRule {
    const id = `rule-${++this.seq}-${Date.now().toString(36)}`
    const full: AlertRule = { ...rule, id }
    this.rules.set(id, full)
    return full
  }

  get(id: string): AlertRule | undefined {
    return this.rules.get(id)
  }

  delete(id: string): boolean {
    return this.rules.delete(id)
  }

  recordFire(fire: AlertFire): void {
    this.fires.unshift(fire)
    if (this.fires.length > MAX_FIRES) this.fires.length = MAX_FIRES
  }

  listFires(limit = 50): AlertFire[] {
    return this.fires.slice(0, limit)
  }

  /** 供测试与重置 */
  clear(): void {
    this.rules.clear()
    this.fires = []
  }
}
