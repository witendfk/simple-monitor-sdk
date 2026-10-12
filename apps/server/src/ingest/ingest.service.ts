/**
 * 消费服务：从队列拉取信封 → 再次校验 → 归一化 → 落库（CH 事件事实 + PG Issue 状态）。
 *
 * 写入时序（M7.5 P1 失败恢复设计，见 issue-store.ts）：
 *  1. PG upsertIssues（幂等，失败抛出 → 队列重试，CH 未写无重复）；
 *  2. CH saveBatch（失败抛出 → 重试；CH 重复计数为已知边界，P4 稳定事件 ID 修复）；
 *  3. count 对账（从 CH 事实源覆写 PG，best-effort：失败仅告警，后续批次自然补齐）。
 *
 * handler 抛错 = 消费失败 → 队列负责重试/死信（at-least-once）。
 * 协议校验失败属毒载荷：同样抛错走死信（不静默吞——需要人工看到）。
 */
import { Inject, Injectable, Logger } from '@nestjs/common'
import { TransportEnvelopeSchema } from '@simple-monitor/protocol'
import { QUEUE_TOKEN, type IEventQueue } from '../queue/event-queue'
import { STORAGE_TOKEN, type IEventStorage } from '../storage/event-storage'
import { ISSUE_STORE_TOKEN, type IIssueStore } from '../storage/issue-store'
import { normalizeEnvelope, type NormalizedEvent } from './normalize'

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name)

  constructor(
    @Inject(QUEUE_TOKEN) private readonly queue: IEventQueue,
    @Inject(STORAGE_TOKEN) private readonly storage: IEventStorage,
    @Inject(ISSUE_STORE_TOKEN) private readonly issues: IIssueStore
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
        const apikey = check.data.auth.apiKey
        await this.upsertIssues(apikey, events)
        await this.storage.saveBatch(events)
        void this.reconcileIssueCounts(apikey, events)
      }
      if (rejected > 0) {
        this.logger.warn(`envelope rejected ${rejected} events (no valid content)`)
      }
    })
  }

  /** PG Issue 状态机：幂等 upsert，失败抛出走重试（CH 未写，无重复副作用） */
  private async upsertIssues(apikey: string, events: NormalizedEvent[]): Promise<void> {
    const errorEvents = events.filter((e) => e.kind === 'error' && e.error?.fingerprint)
    if (errorEvents.length === 0) return
    await this.issues.upsertIssues(
      apikey,
      errorEvents.map((e) => ({
        fingerprint: e.error!.fingerprint as string,
        ts: e.ts,
        ...(e.release ? { release: e.release } : {}),
      }))
    )
  }

  /** count 对账：CH 是事件事实源，覆写 PG 计数；失败仅告警（下个批次自然补齐） */
  private async reconcileIssueCounts(apikey: string, events: NormalizedEvent[]): Promise<void> {
    try {
      const fps = [
        ...new Set(
          events
            .filter((e) => e.kind === 'error' && e.error?.fingerprint)
            .map((e) => e.error!.fingerprint as string)
        ),
      ]
      if (fps.length === 0) return
      const counts = await this.storage.errorCountsByFingerprint(apikey, fps)
      await this.issues.reconcileCounts(
        apikey,
        [...counts].map(([fingerprint, count]) => ({ fingerprint, count }))
      )
    } catch (error) {
      this.logger.warn(`issue count reconcile failed (best-effort): ${String(error)}`)
    }
  }
}
