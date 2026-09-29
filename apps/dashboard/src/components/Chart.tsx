/**
 * ECharts 轻封装：props 变更时 setOption，容器尺寸变化时 resize。
 */
import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'

export function Chart({
  option,
  height = 300,
}: {
  /** 宽松选项类型：视图侧的字面量对象不必逐字段满足判别联合 */
  option: echarts.EChartsCoreOption
  height?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current)
    chartRef.current = chart
    const onResize = (): void => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option])

  return <div ref={ref} style={{ width: '100%', height }} />
}
