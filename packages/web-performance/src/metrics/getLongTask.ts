/**
 * Long Task（M3）：主线程长任务（duration ≥ 50ms）采集。
 *
 * value = 长任务次数（协议 PerfMetric.value 一律 number），
 * 阻塞总时长 / worst / Top-N 归因样本进 detail——定位「谁在阻塞主线程」。
 * 页面隐藏时终值上报（与 CLS 同款 onHidden 模式）。
 */
import { isPerformanceObserverSupported } from '../utils/isSupported'
import observe from '../lib/observe'
import type MetricsStore from '../lib/store'
import type { IReportHandler, IMetrics } from '../types'
import { metricsName } from '../constants'
import { onHidden } from '../lib/onHidden'
import { createLongTaskAccumulator } from '../lib/longTaskAccumulator'

export const initLongTask = (
  store: MetricsStore,
  report: IReportHandler,
  immediately = true
): void => {
  if (!isPerformanceObserverSupported()) return
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return

  const acc = createLongTaskAccumulator()
  const po = observe('longtask', (entry: PerformanceEntry) => {
    acc.process({
      duration: entry.duration,
      name: entry.name,
      attribution: (entry as PerformanceEntry & { attribution?: Record<string, string> })
        .attribution,
    })
  })

  const stopListening = (): void => {
    if (po?.takeRecords) {
      po.takeRecords().forEach((entry: PerformanceEntry) =>
        acc.process({ duration: entry.duration, name: entry.name })
      )
    }
    po?.disconnect()
    if (acc.state.count === 0) return
    const metrics = {
      name: metricsName.LONG_TASK,
      value: acc.state.count,
      detail: {
        totalDuration: Math.round(acc.state.totalDuration),
        worst: Math.round(acc.state.worst),
        top: acc.state.top,
      },
    } as unknown as IMetrics
    store.set(metricsName.LONG_TASK, metrics)
    if (immediately) report(metrics)
  }

  onHidden(stopListening, true)
}
