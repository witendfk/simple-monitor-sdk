/**
 * 概览视图：统计卡片 + Top 错误柱图
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type Overview } from '../api'
import { Chart } from '../components/Chart'

export function OverviewView({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Overview | null>(null)
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
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const option = useMemo(() => {
    const top = data?.topErrors ?? []
    return {
      title: { text: 'Top 错误（近 1 小时）', left: 'center', textStyle: { fontSize: 13 } },
      grid: { left: 120, right: 24, top: 40, bottom: 24 },
      xAxis: { type: 'value' as const },
      yAxis: {
        type: 'category',
        data: top.map((t) => `${t.type}: ${t.message.slice(0, 24)}`).reverse(),
        axisLabel: { width: 110, overflow: 'truncate' },
      },
      series: [
        { type: 'bar', data: top.map((t) => t.count).reverse(), itemStyle: { color: '#c0392b' } },
      ],
      tooltip: { trigger: 'axis' as const },
    }
  }, [data])

  if (error) return <p className="error-text">加载失败：{error}（服务端起了吗？）</p>
  if (!data) return <p>加载中…</p>

  return (
    <section>
      <div className="stat-grid">
        <StatCard label="事件总数" value={data.totalEvents} />
        <StatCard label="错误数" value={data.errorCount} tone="bad" />
        <StatCard label="性能指标数" value={data.perfCount} tone="good" />
        <StatCard label="影响会话" value={data.sessionCount} />
      </div>
      <Chart option={option} height={Math.max(200, (data.topErrors.length || 1) * 36 + 80)} />
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
