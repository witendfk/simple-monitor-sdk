/**
 * 概览视图（P5b 定稿 UI）：健康度英雄卡 + 统计卡 + 错误趋势折线 + Top 错误柱图
 */
import { useEffect, useMemo, useState } from 'react'
import { api, errorsApi, type Overview, type TrendBucket } from '../api'
import { Chart } from '../components/Chart'

export function OverviewView({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Overview | null>(null)
  const [trend, setTrend] = useState<TrendBucket[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .overview(60)
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setError(null)
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    errorsApi
      .trend(24)
      .then((t) => {
        if (!cancelled) setTrend(t.buckets)
      })
      .catch(() => {
        /* 趋势失败不阻塞概览 */
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const trendOption = useMemo(() => {
    if (trend.length === 0) return null
    return {
      grid: { left: 40, right: 16, top: 16, bottom: 28 },
      xAxis: {
        type: 'category' as const,
        data: trend.map((b) => b.hour.slice(11, 16)),
        axisLabel: { color: '#71717a' },
        axisLine: { lineStyle: { color: '#27272a' } },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: '#71717a' },
        splitLine: { lineStyle: { color: '#1f1f23' } },
      },
      series: [
        {
          type: 'line',
          data: trend.map((b) => b.count),
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          itemStyle: { color: '#f87171' },
          lineStyle: { color: '#f87171', width: 2 },
          areaStyle: { color: 'rgba(248, 113, 113, 0.08)' },
        },
      ],
      tooltip: { trigger: 'axis' as const },
    }
  }, [trend])

  const option = useMemo(() => {
    const top = data?.topErrors ?? []
    return {
      title: {
        text: 'Top 错误（近 1 小时）',
        left: 'center',
        textStyle: { fontSize: 13, color: '#a1a1aa' },
      },
      grid: { left: 120, right: 24, top: 40, bottom: 24 },
      xAxis: {
        type: 'value' as const,
        axisLabel: { color: '#71717a' },
        splitLine: { lineStyle: { color: '#1f1f23' } },
      },
      yAxis: {
        type: 'category',
        data: top.map((t) => `${t.type}: ${t.message.slice(0, 24)}`).reverse(),
        axisLabel: { width: 110, overflow: 'truncate', color: '#a1a1aa' },
      },
      series: [
        { type: 'bar', data: top.map((t) => t.count).reverse(), itemStyle: { color: '#f87171' } },
      ],
      tooltip: { trigger: 'axis' as const },
    }
  }, [data])

  if (error) return <p className="error-text">加载失败：{error}（服务端起了吗？）</p>
  if (!data) return <p className="muted">加载中…</p>

  const health = data.health
  const toneText = health.tone === 'healthy' ? '健康' : health.tone === 'watch' ? '需关注' : '差'
  const toneClass =
    health.tone === 'healthy'
      ? 'badge green'
      : health.tone === 'watch'
        ? 'badge orange'
        : 'badge red'
  const toneColor =
    health.tone === 'healthy'
      ? 'var(--green)'
      : health.tone === 'watch'
        ? 'var(--orange)'
        : 'var(--red)'

  return (
    <section>
      {/* 健康度英雄卡 */}
      <div
        className="card"
        style={{ display: 'flex', gap: 28, alignItems: 'stretch', marginBottom: 14 }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            paddingRight: 28,
            borderRight: '1px solid var(--border-soft)',
            minWidth: 190,
          }}
        >
          <div className="dim" style={{ fontSize: 12 }}>
            项目健康度
          </div>
          <div
            style={{
              fontSize: 52,
              fontWeight: 650,
              letterSpacing: '-0.03em',
              lineHeight: 1.05,
              color: toneColor,
            }}
          >
            {health.score}
          </div>
          <div style={{ marginTop: 8 }}>
            <span className={toneClass}>● {toneText}</span>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
            扣分项 TOP 3
          </div>
          {health.deductions.length === 0 ? (
            <div className="muted" style={{ marginTop: 14, fontSize: 13 }}>
              各域均无扣分
            </div>
          ) : (
            health.deductions.map((d) => (
              <div key={d.domain + d.why} className="deduct-item">
                <span
                  className={`badge ${d.domain === '错误' ? 'red' : d.domain === '性能' ? 'orange' : 'gray'}`}
                >
                  {d.domain}
                </span>
                <span className="muted">{d.why}</span>
                <span
                  style={{
                    marginLeft: 'auto',
                    color: 'var(--red)',
                    fontWeight: 600,
                    fontSize: 12.5,
                  }}
                >
                  {d.pts > 0 ? `−${d.pts}` : d.pts}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="事件总数" value={data.totalEvents} />
        <StatCard label="错误数" value={data.errorCount} tone="bad" />
        <StatCard label="性能指标数" value={data.perfCount} tone="good" />
        <StatCard label="影响会话" value={data.sessionCount} />
      </div>

      {trendOption && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 2px' }}>错误趋势</h3>
            <span className="dim" style={{ fontSize: 12 }}>
              近 24 小时 · 按小时
            </span>
          </div>
          <Chart option={trendOption} height={200} />
        </div>
      )}

      <div className="card">
        <Chart option={option} height={Math.max(200, (data.topErrors.length || 1) * 36 + 80)} />
      </div>
    </section>
  )
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  return (
    <div className={`stat-card${tone ? ` stat-${tone}` : ''}`}>
      <div className="stat-value">{value.toLocaleString()}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}
