/**
 * 规则存储 + 触发记录：IAlertRuleStore 接口（M7.5 P1 接口化，async）+ 双实现——
 *  - AlertRuleStore（内存实现）：本地零依赖形态与单测用（重启即失）；
 *  - PgAlertRuleStore（storage/pg/）：PG_URL 在位时启用（规则与触发记录持久化）。
 */
import { Injectable } from '@nestjs/common'
import type { AlertFire, AlertRule } from './alert.types'

export const ALERT_RULE_STORE_TOKEN = 'ALERT_RULE_STORE'

export interface IAlertRuleStore {
  list(apikey?: string): Promise<AlertRule[]>
  get(id: string): Promise<AlertRule | undefined>
  create(rule: Omit<AlertRule, 'id'>): Promise<AlertRule>
  delete(id: string): Promise<boolean>
  recordFire(fire: AlertFire): Promise<void>
  listFires(apikey?: string, limit?: number): Promise<AlertFire[]>
}

const MAX_FIRES = 200

@Injectable()
export class AlertRuleStore implements IAlertRuleStore {
  private rules = new Map<string, AlertRule>()
  private fires: AlertFire[] = []
  private seq = 0

  async list(apikey?: string): Promise<AlertRule[]> {
    const all = [...this.rules.values()]
    return apikey ? all.filter((r) => r.apikey === apikey) : all
  }

  async create(rule: Omit<AlertRule, 'id'>): Promise<AlertRule> {
    const id = `rule-${++this.seq}-${Date.now().toString(36)}`
    const full: AlertRule = { ...rule, id }
    this.rules.set(id, full)
    return full
  }

  async get(id: string): Promise<AlertRule | undefined> {
    return this.rules.get(id)
  }

  async delete(id: string): Promise<boolean> {
    return this.rules.delete(id)
  }

  async recordFire(fire: AlertFire): Promise<void> {
    this.fires.unshift(fire)
    if (this.fires.length > MAX_FIRES) this.fires.length = MAX_FIRES
  }

  async listFires(apikey?: string, limit = 50): Promise<AlertFire[]> {
    const scoped = apikey ? this.fires.filter((f) => f.apikey === apikey) : this.fires
    return scoped.slice(0, limit)
  }

  /** 供测试与重置（内存实现专属，不在接口内） */
  clear(): void {
    this.rules.clear()
    this.fires = []
  }
}
