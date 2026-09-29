/**
 * MemoryQueue 行为测试：确认 / 重试退避 / 死信（at-least-once 语义）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryQueue } from '../src/queue/memory.queue'

describe('MemoryQueue（at-least-once）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('handler 成功：确认并计数', async () => {
    const queue = new MemoryQueue()
    const handler = vi.fn().mockResolvedValue(undefined)
    queue.start(handler)
    await queue.enqueue({ payload: '{}', enqueuedAt: 1 })
    await vi.advanceTimersByTimeAsync(100)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(queue.stats().processed).toBe(1)
    expect(queue.stats().buffered).toBe(0)
  })

  it('handler 失败：重试 2 次后死信（共 3 次尝试）', async () => {
    const queue = new MemoryQueue()
    const handler = vi.fn().mockRejectedValue(new Error('storage down'))
    queue.start(handler)
    await queue.enqueue({ payload: '{}', enqueuedAt: 1 })

    await vi.advanceTimersByTimeAsync(100) // 首次消费：失败
    expect(queue.stats().failed).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000) // 重试 1：失败
    await vi.advanceTimersByTimeAsync(2_000) // 重试 2：失败 → 死信
    expect(handler).toHaveBeenCalledTimes(3)
    expect(queue.stats().deadLettered).toBe(1)
    expect(queue.deadLetters()).toHaveLength(1)
    // 死信不重排：缓冲清空
    expect(queue.stats().buffered).toBe(0)
  })

  it('失败后恢复：重试成功即确认，不进死信', async () => {
    const queue = new MemoryQueue()
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined)
    queue.start(handler)
    await queue.enqueue({ payload: '{}', enqueuedAt: 1 })
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(queue.stats().processed).toBe(1)
    expect(queue.stats().deadLettered).toBe(0)
  })
})
