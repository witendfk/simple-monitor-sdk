/* eslint-disable @typescript-eslint/no-explicit-any -- 测试替身与脏数据构造场景豁免（对齐 batchSenderHardening 先例） */
/**
 * RedisStreamQueue 回归测试（§3.8 P0-5/P1）：消费、死信顺序、监管循环连续崩溃恢复。
 * ioredis 用 FakeRedis 替身注入（CI 无 Redis 基础设施；真实联调由 docker-compose 验收）。
 */
import 'reflect-metadata'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RedisStreamQueue } from '../src/queue/redis-stream.queue'

interface RawMsg {
  id: string
  payload: string
}

/** 最小 ioredis 替身：只实现 RedisStreamQueue 用到的命令面 */
class FakeRedis {
  /** 待消费新消息（xreadgroup 取走） */
  newMessages: RawMsg[] = []
  /** 重投模拟：剩余重投次数（模拟失败消息留 pending 被 XAUTOCLAIM 反复认领；> 只取未投递过的，故需显式次数上限） */
  redeliverLeft = 0
  /** 命令调用记录（断言死信 XADD 先于 XACK 的顺序） */
  calls: string[] = []
  acked: string[] = []
  dead: RawMsg[] = []

  async xgroup(
    _op: string,
    _stream: string,
    _group: string,
    _id: string,
    _mk?: string
  ): Promise<string> {
    this.calls.push('xgroup')
    return 'OK'
  }

  async xreadgroup(...args: string[]): Promise<Array<[string, Array<[string, string[]]>]> | null> {
    this.calls.push('xreadgroup')
    void args
    if (this.newMessages.length === 0) {
      // 模拟 BLOCK 语义（真实命令挂起 2s）：没有它 consumeLoop 会忙循环
      await new Promise((r) => setTimeout(r, 50))
      return null
    }
    if (this.redeliverLeft > 0 && this.dead.length === 0) {
      // 重投轮次：不取走，返回同一批（真实由 30s idle 的 XAUTOCLAIM 驱动，节奏更慢）；
      // 死信已 XACK 的消息 '>' 不再返回（pending 已清），故死信后直接取走
      this.redeliverLeft -= 1
      return [
        [
          'report:queue',
          this.newMessages.map(
            (m) => [m.id, ['payload', m.payload, 'enqueuedAt', '0']] as [string, string[]]
          ),
        ],
      ]
    }
    const batch = this.newMessages.splice(0, 10)
    return [
      [
        'report:queue',
        batch.map((m) => [m.id, ['payload', m.payload, 'enqueuedAt', '0']] as [string, string[]]),
      ],
    ]
  }

  async xack(_stream: string, _group: string, ...ids: string[]): Promise<number> {
    this.calls.push(`xack:${ids.join(',')}`)
    this.acked.push(...ids)
    return ids.length
  }

  async xadd(stream: string, ...args: string[]): Promise<string> {
    this.calls.push(`xadd:${stream}`)
    void args
    const id = `${this.dead.length + 1}-0`
    this.dead.push({ id, payload: '' })
    return id
  }

  async xautoclaim(): Promise<[string, Array<[string, string[]]>, string[]] | null> {
    return null
  }

  disconnect(): void {}
}

function injectFake(queue: RedisStreamQueue, redis: FakeRedis): void {
  ;(queue as unknown as { redis: unknown }).redis = redis
}

describe('RedisStreamQueue（FakeRedis）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('消费成功：handler 收到 payload 并 XACK', async () => {
    const redis = new FakeRedis()
    redis.newMessages = [{ id: '1-1', payload: '{"e":1}' }]
    const queue = new RedisStreamQueue('redis://fake')
    injectFake(queue, redis)

    const seen: string[] = []
    queue.start(async (job) => {
      seen.push(job.payload)
    })
    for (let i = 0; i < 50 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    await queue.stop()

    expect(seen).toEqual(['{"e":1}'])
    expect(redis.acked).toContain('1-1')
    expect(queue.stats().processed).toBe(1)
  })

  it('失败消息经三轮重投（at-least-once 语义）达 3 次：先 XADD 死信流再 XACK（顺序不能颠倒）', async () => {
    const redis = new FakeRedis()
    redis.newMessages = [{ id: '2-1', payload: 'bad' }]
    redis.redeliverLeft = 5
    const queue = new RedisStreamQueue('redis://fake')
    injectFake(queue, redis)

    queue.start(async () => {
      throw new Error('storage down')
    })
    // 等三轮重投完成（每轮 xreadgroup → 失败 → attempts+1，第 3 次进死信）
    for (let i = 0; i < 200 && redis.dead.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    await queue.stop()

    expect(redis.dead).toHaveLength(1)
    expect(queue.stats().deadLettered).toBe(1)
    const addIdx = redis.calls.findIndex((c) => c.startsWith('xadd:report:dead'))
    const ackIdx = redis.calls.findIndex((c) => c.startsWith('xack:2-1'))
    expect(addIdx).toBeGreaterThanOrEqual(0)
    expect(ackIdx).toBeGreaterThan(addIdx)
  })

  it('监管循环：consumeLoop 连续两次崩溃仍恢复消费，无 unhandled rejection', async () => {
    const redis = new FakeRedis()
    redis.newMessages = [{ id: '3-1', payload: 'ok' }]
    const queue = new RedisStreamQueue('redis://fake')
    injectFake(queue, redis)

    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err)
    }
    process.on('unhandledRejection', onUnhandled)

    // 前两次调用 reject（旧实现的重启链第二次崩溃即停摆产生 unhandled rejection），之后恢复真实实现
    const realConsumeLoop = (
      RedisStreamQueue.prototype as unknown as {
        consumeLoop: () => Promise<void>
      }
    ).consumeLoop
    const spy = vi
      .spyOn(queue as unknown as { consumeLoop: () => Promise<void> }, 'consumeLoop')
      .mockRejectedValueOnce(new Error('crash #1'))
      .mockRejectedValueOnce(new Error('crash #2'))
      .mockImplementation(() => realConsumeLoop.call(queue))

    const seen: string[] = []
    queue.start(async (job) => {
      seen.push(job.payload)
    })
    // 两次崩溃 → 3s 监管退避（RECONNECT_DELAY_MS）→ 真实循环消费：等待上限覆盖退避
    for (let i = 0; i < 300 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    await queue.stop()
    process.off('unhandledRejection', onUnhandled)

    expect(spy).toHaveBeenCalledTimes(3)
    expect(seen).toEqual(['ok'])
    expect(unhandled).toEqual([])
  }, 15_000)
})
