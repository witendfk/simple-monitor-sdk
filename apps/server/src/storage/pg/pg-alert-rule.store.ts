/**
 * 告警规则 + 触发记录 PG 实现（M7.5 P1）：alert_rules / alert_history 表。
 * 规则归属项目隔离（project_id 经 public_key 子查询解析）；
 * 规则删除 CASCADE 触发历史（P1 取舍：历史随规则删，避免悬空 rule_id）。
 */
import type { Pool } from 'pg'
import type { AlertFire, AlertRule } from '../../alert/alert.types'
import type { IAlertRuleStore } from '../../alert/rule-store'

interface RuleRow {
  id: string
  type: string
  name: string
  webhook_url: string
  cooldown_minutes: number
  enabled: boolean
  config: unknown
  public_key: string
}

function toRule(row: RuleRow): AlertRule {
  return {
    id: row.id,
    apikey: row.public_key,
    type: row.type as AlertRule['type'],
    name: row.name,
    webhookUrl: row.webhook_url,
    cooldownMinutes: Number(row.cooldown_minutes),
    enabled: row.enabled,
    config: row.config as AlertRule['config'],
  }
}

export class PgAlertRuleStore implements IAlertRuleStore {
  constructor(private readonly pool: Pool) {}

  async list(apikey?: string): Promise<AlertRule[]> {
    const r = apikey
      ? await this.pool.query(
          `SELECT r.id, r.type, r.name, r.webhook_url, r.cooldown_minutes, r.enabled, r.config,
                  p.public_key
           FROM alert_rules r JOIN projects p ON p.id = r.project_id
           WHERE p.public_key = $1 ORDER BY r.created_at DESC`,
          [apikey]
        )
      : await this.pool.query(
          `SELECT r.id, r.type, r.name, r.webhook_url, r.cooldown_minutes, r.enabled, r.config,
                  p.public_key
           FROM alert_rules r JOIN projects p ON p.id = r.project_id
           ORDER BY r.created_at DESC`
        )
    return r.rows.map(toRule)
  }

  async get(id: string): Promise<AlertRule | undefined> {
    const r = await this.pool.query(
      `SELECT r.id, r.type, r.name, r.webhook_url, r.cooldown_minutes, r.enabled, r.config,
              p.public_key
       FROM alert_rules r JOIN projects p ON p.id = r.project_id
       WHERE r.id = $1 LIMIT 1`,
      [id]
    )
    return r.rows[0] ? toRule(r.rows[0]) : undefined
  }

  async create(rule: Omit<AlertRule, 'id'>): Promise<AlertRule> {
    const id = `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const r = await this.pool.query(
      `INSERT INTO alert_rules (id, project_id, type, name, webhook_url, cooldown_minutes, enabled, config)
       VALUES ($1, (SELECT id FROM projects WHERE public_key = $2), $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        id,
        rule.apikey,
        rule.type,
        rule.name,
        rule.webhookUrl,
        rule.cooldownMinutes,
        rule.enabled,
        JSON.stringify(rule.config),
      ]
    )
    if ((r.rowCount ?? 0) === 0) {
      throw new Error(`alert rule create failed: unknown apikey ${rule.apikey}`)
    }
    return { ...rule, id }
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM alert_rules WHERE id = $1', [id])
    return (r.rowCount ?? 0) > 0
  }

  async recordFire(fire: AlertFire): Promise<void> {
    await this.pool.query(
      `INSERT INTO alert_history (rule_id, apikey, fired_at, message, context)
       VALUES ($1, $2, $3, $4, $5)`,
      [fire.ruleId, fire.apikey, new Date(fire.firedAt), fire.message, JSON.stringify(fire.context)]
    )
  }

  async listFires(apikey?: string, limit = 50): Promise<AlertFire[]> {
    const r = apikey
      ? await this.pool.query(
          `SELECT h.id, h.rule_id, h.apikey, h.fired_at, h.message, h.context, COALESCE(r.name, '') AS rule_name
           FROM alert_history h LEFT JOIN alert_rules r ON r.id = h.rule_id
           WHERE h.apikey = $1 ORDER BY h.fired_at DESC LIMIT $2`,
          [apikey, limit]
        )
      : await this.pool.query(
          `SELECT h.id, h.rule_id, h.apikey, h.fired_at, h.message, h.context, COALESCE(r.name, '') AS rule_name
           FROM alert_history h LEFT JOIN alert_rules r ON r.id = h.rule_id
           ORDER BY h.fired_at DESC LIMIT $1`,
          [limit]
        )
    return r.rows.map((row) => ({
      id: String(row.id),
      ruleId: row.rule_id,
      ruleName: row.rule_name,
      apikey: row.apikey,
      firedAt: new Date(row.fired_at).toISOString(),
      message: row.message,
      context: row.context as Record<string, unknown>,
    }))
  }
}
