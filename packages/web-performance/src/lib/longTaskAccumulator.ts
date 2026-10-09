/**
 * Long Task 累加器（M3，纯状态机，脱离浏览器可单测）
 *
 * 输入 longtask entry（duration ≥ 50ms 的主线程长任务），维护：
 *  - count：长任务总次数；
 *  - totalDuration：总阻塞时长（衡量长任务整体严重度）；
 *  - worst：最严重一次的 duration；
 *  - top：按 duration 降序的 Top-N 样本（含归因，定位「谁在阻塞主线程」）；
 *  - tiers：时长分档计数（M7 ADR-8 增补 5：50-100 / 100-200 / ≥200ms，与
 *    Lighthouse 阻塞口径互补——总量看不出「一次性 300ms 卡顿」的体验伤害，分档能）。
 */
export const LONG_TASK_TOP_N = 10

/** 分档阈值（ms）：[50,100) 轻度 / [100,200) 中度 / ≥200 重度 */
export const LONG_TASK_TIER_THRESHOLDS = [50, 100, 200] as const

export interface LongTaskInput {
  duration: number
  name?: string
  /** TaskAttributionLite：containerName / containerType / containerSrc */
  attribution?: { containerName?: string; containerType?: string; containerSrc?: string }
}

export interface LongTaskState {
  count: number
  totalDuration: number
  worst: number
  top: Array<LongTaskInput & { duration: number }>
  /** 分档计数：low（50-100）/ mid（100-200）/ high（≥200） */
  tiers: { low: number; mid: number; high: number }
}

/** 单任务分档（导出供测试与外部复用） */
export function classifyLongTaskTier(duration: number): 'low' | 'mid' | 'high' {
  if (duration >= LONG_TASK_TIER_THRESHOLDS[2]) return 'high'
  if (duration >= LONG_TASK_TIER_THRESHOLDS[1]) return 'mid'
  return 'low'
}

export const createLongTaskAccumulator = (topN: number = LONG_TASK_TOP_N) => {
  const state: LongTaskState = {
    count: 0,
    totalDuration: 0,
    worst: 0,
    top: [],
    tiers: { low: 0, mid: 0, high: 0 },
  }
  return {
    process(entry: LongTaskInput): void {
      const duration =
        typeof entry?.duration === 'number' && entry.duration > 0 ? entry.duration : 0
      if (duration <= 0) return
      state.count += 1
      state.totalDuration += duration
      if (duration > state.worst) state.worst = duration
      state.tiers[classifyLongTaskTier(duration)] += 1
      state.top.push({ ...entry, duration })
      state.top.sort((a, b) => b.duration - a.duration)
      if (state.top.length > topN) state.top.length = topN
    },
    state,
  }
}
