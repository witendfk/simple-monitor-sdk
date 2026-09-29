/**
 * Redis Stream 队列实现（生产形态）：consumer group + pending 重投 + 死信流。
 *
 * 语义（与 MemoryQueue 对齐的 at-least-once）：
 *  - 入队：XADD report:queue（MAXLEN ~ 100000 防下游宕机撑爆内存，丢最老可容忍）；
 *  - 消费：XREADGROUP 拉新消息，处理成功 XACK；
 *  - 失败：不 XACK，消息留在 pending list；XAUTOCLAIM 按 min-idle-time 重投
 *    （进程崩溃也不丢——pending 消息由存活消费者认领），本进程内按消息 id 计数，
 *    超过 MAX_ATTEMPTS → XACK + XADD report:dead（死信流，人工排查）；
 *  - 全部循环异常就地消化（异步纪律）：Redis 短暂不可用时退避后继续。
 */
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import Redis from 'ioredis'
import type { IEventQueue, QueueJob, QueueStats } from './event-queue'

const STREAM = 'report:queue'
const DEAD_STREAM = 'report:dead'
const GROUP = 'report-consumers'
const CONSUMER = `c-${process.pid}`
const MAX_ATTEMPTS = 3
const MAXLEN = 100_000
const READ_BLOCK_MS = 2_000
const READ_COUNT = 100
/** pending 消息重投阈值：空闲超过该时长才认领（避免与在途处理竞争） */
const CLAIM_MIN_IDLE_MS = 30_000
const CLAIM_INTERVAL_MS = 15_000
const RECONNECT_DELAY_MS = 3_000

interface RawMessage {
  id: string
  payload: string
  enqueuedAt: number
}

@Injectable()
export class RedisStreamQueue implements IEventQueue, OnApplicationShutdown {
  private readonly logger = new Logger(RedisStreamQueue.name)
  private readonly redis: Redis
  private handler: ((job: QueueJob) => Promise<void>) | null = null
  private running = false
  private loopPromise: Promise<void> | null = null
  private claimTimer: ReturnType<typeof setTimeout> | null = null
  private readonly attempts = new Map<string, number>()
  private processed = 0
  private failed = 0
  private deadLettered = 0
  private buffered = 0

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 })
  }

  async enqueue(job: QueueJob): Promise<void> {
    await this.redis.xadd(
      STREAM,
      'MAXLEN',
      '~',
      String(MAXLEN),
      '*',
      'payload',
      job.payload,
      'enqueuedAt',
      String(job.enqueuedAt)
    )
    this.buffered += 1
  }

  start(handler: (job: QueueJob) => Promise<void>): void {
    if (this.running) return
    this.running = true
    this.handler = handler
    this.loopPromise = this.consumeLoop()
    this.claimTimer = setInterval(() => {
      void this.reclaimPending()
    }, CLAIM_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.claimTimer) {
      clearInterval(this.claimTimer)
      this.claimTimer = null
    }
    if (this.loopPromise) {
      await this.loopPromise
      this.loopPromise = null
    }
    this.redis.disconnect()
  }

  stats(): QueueStats {
    return {
      buffered: this.buffered,
      deadLettered: this.deadLettered,
      processed: this.processed,
      failed: this.failed,
    }
  }

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      let batch: RawMessage[] = []
      try {
        await this.ensureGroup()
        batch = await this.readNew()
      } catch (error) {
        this.logger.warn(`consume loop error, retrying: ${String(error)}`)
        await this.sleep(RECONNECT_DELAY_MS)
        continue
      }
      if (batch.length === 0) continue
      for (const message of batch) {
        await this.processOne(message)
      }
    }
  }

  /** 读新消息（'>' 只取未投递过的）；无消息/出错返回空 */
  private async readNew(): Promise<RawMessage[]> {
    const res = (await this.redis.xreadgroup(
      'GROUP',
      GROUP,
      CONSUMER,
      'COUNT',
      String(READ_COUNT),
      'BLOCK',
      String(READ_BLOCK_MS),
      'STREAMS',
      STREAM,
      '>'
    )) as Array<[string, Array<[string, string[]]>]> | null
    if (!res) return []
    return res[0][1].map(([id, fields]) => this.toMessage(id, fields))
  }

  /** 认领空闲 pending 消息（崩溃/失败重投）：at-least-once 的崩溃安全面 */
  private async reclaimPending(): Promise<void> {
    if (!this.running) return
    try {
      const res = (await this.redis.xautoclaim(
        STREAM,
        GROUP,
        CONSUMER,
        String(CLAIM_MIN_IDLE_MS),
        '0',
        'COUNT',
        String(READ_COUNT)
      )) as [string, Array<[string, string[]]>, string[]] | null
      const messages = res?.[1] ?? []
      for (const message of messages) {
        await this.processOne(this.toMessage(message[0], message[1]))
      }
    } catch (error) {
      this.logger.warn(`reclaim pending error: ${String(error)}`)
    }
  }

  private async processOne(message: RawMessage): Promise<void> {
    if (!this.handler) return
    try {
      await this.handler({ payload: message.payload, enqueuedAt: message.enqueuedAt })
      await this.redis.xack(STREAM, GROUP, message.id)
      this.attempts.delete(message.id)
      this.processed += 1
      this.buffered = Math.max(0, this.buffered - 1)
    } catch (error) {
      this.failed += 1
      await this.handleFailure(message, error)
    }
  }

  private async handleFailure(message: RawMessage, error: unknown): Promise<void> {
    const attempts = (this.attempts.get(message.id) ?? 0) + 1
    this.attempts.set(message.id, attempts)
    this.logger.warn(`message ${message.id} attempt ${attempts} failed: ${String(error)}`)
    if (attempts >= MAX_ATTEMPTS) {
      // 死信：确认原消息 + 落死信流（人工排查/重放）
      await this.redis.xack(STREAM, GROUP, message.id)
      await this.redis.xadd(
        DEAD_STREAM,
        'MAXLEN',
        '~',
        String(MAXLEN),
        '*',
        'payload',
        message.payload,
        'error',
        String(error).slice(0, 500)
      )
      this.attempts.delete(message.id)
      this.deadLettered += 1
    }
    // 未达上限：不 XACK，留在 pending，由 reclaimPending 按 idle 重投
  }

  private toMessage(id: string, fields: string[]): RawMessage {
    const map = new Map<string, string>()
    for (let i = 0; i < fields.length; i += 2) {
      map.set(fields[i], fields[i + 1] ?? '')
    }
    return {
      id,
      payload: map.get('payload') ?? '',
      enqueuedAt: Number(map.get('enqueuedAt') ?? 0),
    }
  }

  private async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM')
    } catch (error) {
      // BUSYGROUP = 已存在，正常路径
      if (!String(error).includes('BUSYGROUP')) throw error
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop()
  }
}
