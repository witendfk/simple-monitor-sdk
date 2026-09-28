/**
 * Long Task 测试（M3）：累加器纯逻辑 + 采集器环境防御
 */
import { describe, it, expect } from 'vitest'
import {
  createLongTaskAccumulator,
  LONG_TASK_TOP_N,
} from '../../packages/web-performance/src/lib/longTaskAccumulator'
import { initLongTask } from '../../packages/web-performance/src/metrics/getLongTask'
import MetricsStore from '../../packages/web-performance/src/lib/store'

describe('longTaskAccumulator（纯逻辑）', () => {
  it('计数/总时长/worst 累计正确', () => {
    const acc = createLongTaskAccumulator()
    acc.process({ duration: 60 })
    acc.process({ duration: 120 })
    acc.process({ duration: 55 })
    expect(acc.state.count).toBe(3)
    expect(acc.state.totalDuration).toBe(235)
    expect(acc.state.worst).toBe(120)
  })

  it('非正 duration 跳过（不产生脏计数）', () => {
    const acc = createLongTaskAccumulator()
    acc.process({ duration: 0 })
    acc.process({ duration: -5 })
    acc.process(undefined as unknown as LongTaskInput)
    expect(acc.state.count).toBe(0)
  })

  it('Top-N 降序保留并截断（归因样本随行）', () => {
    const acc = createLongTaskAccumulator(3)
    for (const d of [50, 200, 80, 150, 300])
      acc.process({ duration: d, attribution: { containerName: 's' } })
    expect(acc.state.top.map((t) => t.duration)).toEqual([300, 200, 150])
    expect(acc.state.top[0].attribution?.containerName).toBe('s')
    expect(LONG_TASK_TOP_N).toBe(10)
  })
})

describe('initLongTask（环境防御）', () => {
  it('不支持 longtask 的环境静默跳过，不抛错', () => {
    const store = new MetricsStore()
    expect(() => initLongTask(store, () => undefined, true)).not.toThrow()
    expect(store.has('long-task')).toBe(false)
  })
})
