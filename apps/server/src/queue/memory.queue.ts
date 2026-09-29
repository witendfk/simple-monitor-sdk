/**
 * 内存队列实现（本地开发 / 测试 / 演示）：批处理泵 + 重试退避 + 死信。
 *
 * 语义与 Redis Stream 版对齐：at-least-once、失败重试 MAX_ATTEMPTS 次后进死信。
 * 全部异步路径就地消化（异步纪律：消费泵是 fire-and-forget 定时驱动）。
 */
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import type { IEventQueue, QueueJob, QueueStats } from './event-queue'

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 1_000
/** 消费泵的批大小与轮询间隔 */
const BATCH_SIZE = 100
const POLL_INTERVAL_MS = 50

/** 重试次数挂在 job 侧车字段（WeakMap 亦可，直接字段便于调试观测） */
interface JobWithAttempts extends QueueJob {
  __attempts?: number
}

@Injectable()
export class MemoryQueue implements IEventQueue, OnApplicationShutdown {
  private readonly logger = new Logger(MemoryQueue.name)
  private buffer: JobWithAttempts[] = []
  private readonly dead: JobWithAttempts[] = []
  private processed = 0
  private failed = 0
  private handler: ((job: QueueJob) => Promise<void>) | null = null
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimers = new Set<ReturnType<typeof setTimeout>>()
  private draining = false

  async enqueue(job: QueueJob): Promise<void> {
    this.buffer.push(job)
  }

  start(handler: (job: QueueJob) => Promise<void>): void {
    if (this.handler) return
    this.handler = handler
    this.schedulePump()
  }

  async stop(): Promise<void> {
    this.handler = null
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer)
      this.pumpTimer = null
    }
    for (const t of this.retryTimers) clearTimeout(t)
    this.retryTimers.clear()
  }

  onApplicationShutdown(): void {
    void this.stop()
  }

  stats(): QueueStats {
    return {
      buffered: this.buffer.length,
      deadLettered: this.dead.length,
      processed: this.processed,
      failed: this.failed,
    }
  }

  deadLetters(): QueueJob[] {
    return this.dead
  }

  private schedulePump(): void {
    if (this.pumpTimer || !this.handler) return
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null
      void this.drain()
    }, POLL_INTERVAL_MS)
  }

  /** 消费泵：任何异常就地消化，失败任务走重试/死信 */
  private async drain(): Promise<void> {
    if (this.draining || !this.handler) return
    this.draining = true
    try {
      const batch = this.buffer.splice(0, BATCH_SIZE)
      for (const job of batch) {
        try {
          await this.handler(job)
          this.processed += 1
        } catch (error) {
          this.failed += 1
          this.handleFailure(job, error)
        }
      }
    } finally {
      this.draining = false
    }
    this.schedulePump()
  }

  private handleFailure(job: JobWithAttempts, error: unknown): void {
    const attempts = (job.__attempts ?? 0) + 1
    if (attempts >= MAX_ATTEMPTS) {
      this.dead.push(job)
      this.logger.error(`job dead-lettered after ${attempts} attempts: ${String(error)}`)
      return
    }
    this.logger.warn(`job attempt ${attempts} failed, retrying: ${String(error)}`)
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer)
      job.__attempts = attempts
      this.buffer.push(job)
      this.schedulePump()
    }, RETRY_DELAY_MS * attempts)
    this.retryTimers.add(timer)
  }
}
