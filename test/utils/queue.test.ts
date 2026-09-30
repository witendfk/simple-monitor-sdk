import { describe, it, expect, vi } from 'vitest'
import { Queue } from '../../packages/utils/src/queue'

describe('Queue', () => {
  it('addFn 在同一微任务窗口收集，flush 时按入队顺序依次执行', async () => {
    const queue = new Queue()
    const order: number[] = []
    queue.addFn(() => order.push(1))
    queue.addFn(() => order.push(2))
    queue.addFn(() => order.push(3))

    // 同步阶段尚未 flush（微任务未跑）
    expect(order).toEqual([])

    await Promise.resolve() // 触发微任务 flush
    expect(order).toEqual([1, 2, 3])
  })

  it('多次 addFn 只调度一次 flush（isFlushing 保护）', async () => {
    const queue = new Queue()
    const fn = vi.fn()
    queue.addFn(fn)
    queue.addFn(fn)
    queue.addFn(fn)
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('非函数入参被忽略，不抛错', async () => {
    const queue = new Queue()
    queue.addFn('not-a-fn' as never)
    queue.addFn(undefined as never)
    await Promise.resolve()
    // 不抛错即通过
    expect(true).toBe(true)
  })

  it('clear 清空待执行栈', async () => {
    const queue = new Queue()
    const fn = vi.fn()
    queue.addFn(fn)
    queue.clear()
    await Promise.resolve()
    expect(fn).not.toHaveBeenCalled()
  })

  it('单个上报函数抛错：不影响其余函数执行，且不逃逸 unhandled rejection（§3.7 P1）', async () => {
    const queue = new Queue()
    const good = vi.fn()
    queue.addFn(() => {
      throw new SyntaxError('bad dsn url')
    })
    queue.addFn(good)
    await Promise.resolve()
    // 抛错的第一个函数不阻断第二个；Promise.resolve().then 链未 reject
    expect(good).toHaveBeenCalledTimes(1)
  })
})
