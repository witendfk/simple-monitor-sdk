/**
 * 消费服务：从队列拉取信封 → 再次校验 → 归一化 → 落库。
 *
 * handler 抛错 = 消费失败 → 队列负责重试/死信（at-least-once）。
 * 协议校验失败属毒载荷：同样抛错走死信（不静默吞——需要人工看到）。
 */
import { Injectable, Inject, Logger } from '@nestjs/common'
import { TransportEnvelopeSchema } from '@simple-monitor/protocol'
import { QUEUE_TOKEN, type IEventQueue } from '../queue/event-queue'
import { STORAGE_TOKEN, type IEventStorage } from '../storage/event-storage'
import { normalizeEnvelope } from './normalize'

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name)

  constructor(
    @Inject(QUEUE_TOKEN) private readonly queue: IEventQueue,
    @Inject(STORAGE_TOKEN) private readonly storage: IEventStorage
  ) {}

  start(): void {
    this.queue.start(async (job) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(job.payload)
      } catch (error) {
        // 队列里的载荷都来自已校验的接入层：解析失败=损坏/篡改，走死信人工排查
        throw new Error(`payload json parse failed: ${String(error)}`)
      }
      const check = TransportEnvelopeSchema.safeParse(parsed)
      if (!check.success) {
        throw new Error(`payload envelope validation failed: ${check.error.issues[0]?.message}`)
      }

      const { events, rejected } = normalizeEnvelope(check.data)
      if (events.length > 0) {
        await this.storage.saveBatch(events)
      }
      if (rejected > 0) {
        this.logger.warn(`envelope rejected ${rejected} events (no valid content)`)
      }
    })
  }
}
