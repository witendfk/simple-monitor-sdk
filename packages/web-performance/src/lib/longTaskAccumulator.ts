/**
 * Long Task 累加器（M3，纯状态机，脱离浏览器可单测）
 *
 * 输入 longtask entry（duration ≥ 50ms 的主线程长任务），维护：
 *  - count：长任务总次数；
 *  - totalDuration：总阻塞时长（衡量长任务整体严重度）；
 *  - worst：最严重一次的 duration；
 *  - top：按 duration 降序的 Top-N 样本（含归因，定位「谁在阻塞主线程」）。
 */
export const LONG_TASK_TOP_N = 10

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
}

export const createLongTaskAccumulator = (topN: number = LONG_TASK_TOP_N) => {
  const state: LongTaskState = { count: 0, totalDuration: 0, worst: 0, top: [] }
  return {
    process(entry: LongTaskInput): void {
      const duration =
        typeof entry?.duration === 'number' && entry.duration > 0 ? entry.duration : 0
      if (duration <= 0) return
      state.count += 1
      state.totalDuration += duration
      if (duration > state.worst) state.worst = duration
      state.top.push({ ...entry, duration })
      state.top.sort((a, b) => b.duration - a.duration)
      if (state.top.length > topN) state.top.length = topN
    },
    state,
  }
}
