/**
 * 告警视图：规则管理（创建/启停/删除）+ 触发记录
 */
import { useCallback, useEffect, useState } from 'react'
import { alertApi, type AlertFire, type AlertRule, type AlertRule as AlertRuleType } from '../api'

export function AlertsView({ refreshKey }: { refreshKey: number }) {
  const [rules, setRules] = useState<AlertRuleType[]>([])
  const [fires, setFires] = useState<AlertFire[]>([])
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    apikey: 'demo-key',
    name: '',
    webhookUrl: '',
    type: 'error_spike' as 'error_spike' | 'perf_threshold',
    metric: 'largest-contentful-paint',
    threshold: 4000,
  })
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => {
    alertApi
      .list()
      .then(setRules)
      .catch((e: Error) => setError(e.message))
    alertApi
      .fires(20)
      .then(setFires)
      .catch(() => undefined)
  }, [])

  useEffect(load, [load, refreshKey])

  const create = async (): Promise<void> => {
    setCreating(true)
    try {
      await alertApi.create({
        apikey: form.apikey,
        name: form.name || `${form.type === 'error_spike' ? '错误突增' : form.metric} 告警`,
        webhookUrl: form.webhookUrl,
        cooldownMinutes: 15,
        enabled: true,
        type: form.type,
        config:
          form.type === 'error_spike'
            ? { windowMinutes: 15, baselineMinutes: 360, minCount: 20, multiplier: 3 }
            : { metric: form.metric, threshold: Number(form.threshold), windowMinutes: 60 },
      })
      setForm({ ...form, name: '', webhookUrl: '' })
      load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const toggle = async (rule: AlertRuleType): Promise<void> => {
    // 启停 = 删除 + 重建（内存存储无 update；Postgres 切片换 PUT）
    await alertApi.remove(rule.id).catch(() => undefined)
    if (rule.enabled) {
      await alertApi.create({ ...rule, enabled: false }).catch(() => undefined)
    } else {
      const { id: _id, ...rest } = rule
      await alertApi.create(rest).catch(() => undefined)
    }
    load()
  }

  return (
    <section>
      <h4>新建规则</h4>
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <select
          className="input"
          style={{ minWidth: 140 }}
          value={form.type}
          onChange={(e) => setForm({ ...form, type: e.target.value as typeof form.type })}
        >
          <option value="error_spike">错误突增</option>
          <option value="perf_threshold">性能阈值</option>
        </select>
        {form.type === 'perf_threshold' && (
          <>
            <select
              className="input"
              style={{ minWidth: 180 }}
              value={form.metric}
              onChange={(e) => setForm({ ...form, metric: e.target.value })}
            >
              <option value="largest-contentful-paint">LCP</option>
              <option value="first-contentful-paint">FCP</option>
              <option value="interaction-to-next-paint">INP</option>
              <option value="cumulative-layout-shift">CLS</option>
            </select>
            <input
              className="input"
              style={{ minWidth: 120 }}
              type="number"
              value={form.threshold}
              onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })}
              title="P75 阈值"
            />
          </>
        )}
        <input
          className="input"
          placeholder="规则名（可选）"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          className="input"
          style={{ minWidth: 320 }}
          placeholder="webhook 地址（https://…）"
          value={form.webhookUrl}
          onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
        />
        <button className="button" disabled={creating || !form.webhookUrl} onClick={create}>
          创建
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}

      <h4>规则（{rules.length}）</h4>
      {rules.length === 0 && <p className="muted">暂无规则</p>}
      {rules.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>状态</th>
              <th>冷却</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>
                  <code>{r.type}</code>
                </td>
                <td>{r.enabled ? '✅ 启用' : '⏸ 停用'}</td>
                <td>{r.cooldownMinutes}min</td>
                <td>
                  <button className="button" onClick={() => toggle(r)}>
                    {r.enabled ? '停用' : '启用'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4>触发记录（最近 {fires.length}）</h4>
      {fires.length === 0 && <p className="muted">暂无触发</p>}
      <ul className="crumb-list">
        {fires.map((f) => (
          <li key={f.id}>
            <span className="muted">{new Date(f.firedAt).toLocaleString()}</span>{' '}
            <strong>{f.ruleName}</strong>{' '}
            <span className="mono">{f.message}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
