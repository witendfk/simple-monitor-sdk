/**
 * 队列契约（DIP）：接入层只面向 IEventQueue 编程。
 *
 * 语义：at-least-once——handler 抛错视为消费失败，实现方负责
 * 重试（含退避）与死信；handler 成功即确认。
 * 实现方必须自行消化全部异步异常（异步纪律：不允许 unhandled rejection）。
 */
export interface QueueJob {
  /** 原始信封 JSON（协议层已校验形状，队列只搬运字符串） */
  payload: string
  /** 接收时刻 ms（背压/延迟观测用） */
  enqueuedAt: number
}

export interface QueueStats {
  buffered: number
  deadLettered: number
  processed: number
  failed: number
}

export const QUEUE_TOKEN = 'QUEUE'

export interface IEventQueue {
  /** 入队（接入层调用，必须非阻塞快速返回） */
  enqueue(job: QueueJob): Promise<void>
  /** 启动消费（重复调用安全） */
  start(handler: (job: QueueJob) => Promise<void>): void
  /** 停止消费（优雅关闭：清定时器/断开连接，等待在途任务完成） */
  stop(): Promise<void>
  stats(): QueueStats
}
