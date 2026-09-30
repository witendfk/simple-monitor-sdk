/**
 * 性能视图：指标选择 + P50/P75/P95 分位柱图
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type PerfQuantiles } from '../api'
import { Chart } from '../components/Chart'

const METRICS = [
  { value: 'largest-contentful-paint', label: 'LCP' },
  { value: 'first-contentful-paint', label: 'FCP' },
  { value: 'interaction-to-next-paint', label: 'INP' },
  { value: 'cumulative-layout-shift', label: 'CLS' },
  { value: 'fps', label: 'FPS' },
  { value: 'long-task', label: 'Long Task' },
]

export function PerformanceView({ refreshKey }: { refreshKey: number }) {
  const [metric, setMetric] = useState('largest-contentful-paint')
  const [data, setData] = useState<PerfQuantiles | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .performance(metric, 24 * 60)
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
  }, [metric, refreshKey])

  const option = useMemo(() => {
    return {
      title: {
        text: `${metric} 分位（近 24h，样本 ${data?.count ?? 0}）`,
        left: 'center',
        textStyle: { fontSize: 13 },
      },
      xAxis: { type: 'category' as const, data: ['P50', 'P75', 'P95'] },
      yAxis: { type: 'value' as const },
      series: [
        {
          type: 'bar' as const,
          data: [data?.p50, data?.p75, data?.p95].map((v) => (typeof v === 'number' ? v : 0)),
          barWidth: 60,
          itemStyle: { color: '#2c5f8a' },
          label: {
            show: true,
            position: 'top' as const,
            formatter: ({ value }: { value: number }) => String(value),
          },
        },
      ],
      tooltip: { trigger: 'axis' as const },
    }
  }, [data, metric])

  return (
    <section>
      <div className="toolbar">
        <select className="input" value={metric} onChange={(e) => setMetric(e.target.value)}>
          {METRICS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error-text">加载失败：{error}</p>}
      <Chart option={option} height={340} />
    </section>
  )
}
