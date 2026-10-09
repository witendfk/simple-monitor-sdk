/**
 * INP（Interaction to Next Paint）—— 2024-03-12 取代 FID 成为 Core Web Vital。
 *
 * 测量整个页面生命周期内，用户交互（点击/按键/触摸）的「输入到下一帧绘制」全链路延迟。
 * FID 只测首次输入延迟，INP 覆盖所有交互，更准确。
 *
 * 【算法】对齐 Google web-vitals 官方定义：
 *  - 按 interactionId 聚合：一次交互产生多条 event entry（pointerdown/click 等），
 *    该交互的延迟 = 组内所有 entry 中最大的 duration。
 *  - 页面隐藏时计算最终值：
 *    · 交互数 ≤ 50：取所有交互里的最大延迟（worst-case）；
 *    · 交互数 > 50：取所有交互延迟的 P98（忽略 top 2%，过滤 GC/IO 等系统抖动噪声）。
 *  旧实现直接对所有 entry 取单个最大，长会话会被尾部噪声带偏、报值偏高。
 */
import { isPerformanceObserverSupported } from '../utils/isSupported'
import observe from '../lib/observe'
import getFirstHiddenTime from '../lib/getFirstHiddenTime'
import { onHidden } from '../lib/onHidden'
import { computeINPFromInteractions } from '../lib/computeINP'
import type { InteractionRecord } from '../lib/computeINP'
import type MetricsStore from '../lib/store'
import type { IReportHandler, IScoreConfig, IMetrics, PerformanceEventTiming } from '../types'
import { metricsName } from '../constants'
import { roundByFour } from '../utils'
import calcScore from '../lib/calculateScore'

export const initINP = (
  store: MetricsStore,
  report: IReportHandler,
  immediately = true,
  scoreConfig?: IScoreConfig
): void => {
  if (!isPerformanceObserverSupported()) {
    console.warn('browser do not support performanceObserver')
    return
  }

  const firstHiddenTime = getFirstHiddenTime()
  // 按 interactionId 聚合：一次交互的多条 entry 合并为一个 record（取组内最大 duration）
  const interactions = new Map<number, InteractionRecord>()

  const entryHandler = (entry: PerformanceEntry): void => {
    const e = entry as PerformanceEventTiming
    if (!e.interactionId || e.startTime >= firstHiddenTime.timeStamp) return

    const existing = interactions.get(e.interactionId)
    if (!existing || e.duration > existing.duration) {
      interactions.set(e.interactionId, {
        duration: e.duration,
        name: e.name,
        target: e.target,
      })
    }
  }

  // durationThreshold 40（对齐官方 web-vitals）：默认 104ms 会滤掉多数交互，
  // INP 的 P98 需要全量交互样本（§3.7）
  const po = observe('event', entryHandler, { durationThreshold: 40 })

  const stopListening = (): void => {
    if (po?.takeRecords) {
      po.takeRecords().map(entryHandler)
    }
    po?.disconnect()

    if (!store.has(metricsName.INP) && interactions.size > 0) {
      const { value, record } = computeINPFromInteractions([...interactions.values()])
      const metrics = {
        name: metricsName.INP,
        value: {
          eventName: record?.name,
          targetCls: (record?.target as HTMLElement)?.className,
          duration: roundByFour(value, 2),
        },
        score: calcScore(metricsName.INP, value, scoreConfig),
      } as IMetrics

      store.set(metricsName.INP, metrics)
      if (immediately) report(metrics)
    }
  }

  onHidden(stopListening, true)
}
