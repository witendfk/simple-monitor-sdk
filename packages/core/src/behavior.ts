/**
 * 行为域追踪器（M7，ADR-8）
 *
 * 职责：behavior / api 事件的入队、按域采样、防风暴与独立发送。
 *  - 独立 BatchSender 实例：行为信封不与 error/perf 混组（ADR-8 兼容双保险）；
 *  - 采样：trackSampleRate（行为域）/ apiSampleRate（成功请求明细），错误主通道不受影响；
 *  - 防风暴：单会话 behavior 事件上限（LIMITS.maxBehaviorPerSession，超出静默丢弃）；
 *    track props 键数/序列化体积截断（LIMITS.trackPropsKeys / trackPropsBytes）。
 *
 * DOM 侧采集（PV/停留/曝光/声明式委托/白屏）在 browser/behaviors.ts，
 * 通过本类实例上报；代码埋点 track()/time() 由 MonitorClient 转发到这里。
 */
import type { ApiPayload, BehaviorPayload } from '@simple-monitor/protocol'
import { LIMITS } from '@simple-monitor/protocol'
import { logger } from '@simple-monitor/utils'
import { BatchSender } from './batchSender'
import { buildBehaviorEnvelope, type BehaviorEnvelopeContext } from './behaviorEnvelope'

export interface BehaviorTrackerDeps {
  /** 发送 dsn 取值器（惰性：bindOptions 后才有 trackDsn） */
  readonly getDsn: () => string
  /** 信封上下文取值器（session/options/viewId/device 惰性求值） */
  readonly getContext: () => BehaviorEnvelopeContext
  /** 行为域采样率取值器（options.trackSampleRate） */
  readonly getTrackSampleRate: () => number
  /** 成功请求采样率取值器（options.apiSampleRate） */
  readonly getApiSampleRate: () => number
}

function roll(rate: number): boolean {
  return Math.random() < rate
}

function sanitizeProps(
  props: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!props || typeof props !== 'object') return undefined
  const keys = Object.keys(props).slice(0, LIMITS.trackPropsKeys)
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = props[k]
  try {
    const json = JSON.stringify(out)
    if (json.length > LIMITS.trackPropsBytes) {
      // 序列化超限：丢弃 props（键级细截复杂度高于收益，宁可整弃不造假数据）
      return undefined
    }
    void json
  } catch {
    return undefined
  }
  return out
}

export class BehaviorTracker {
  private readonly sender: BatchSender
  private count = 0
  private destroyed = false

  constructor(private readonly deps: BehaviorTrackerDeps) {
    this.sender = new BatchSender({
      // 行为信封：auth/session/context 齐备，无用户脏数据；失败按 BatchSender 常规退避
      buildEnvelope: (payloads) => {
        const envelope = buildBehaviorEnvelope(
          this.deps.getContext(),
          payloads.map((p) => p.data)
        )
        return { dsn: payloads[0].dsn, envelope }
      },
    })
  }

  /** 入队一条 behavior 事件（按域采样 + 防风暴） */
  sendBehavior(behavior: BehaviorPayload): void {
    if (this.destroyed) return
    if (!roll(this.deps.getTrackSampleRate())) return
    this.enqueue({ kind: 'behavior', behavior })
  }

  /** 入队一条成功请求明细（独立采样，默认 0.1） */
  sendApi(api: ApiPayload): void {
    if (this.destroyed) return
    if (!roll(this.deps.getApiSampleRate())) return
    this.enqueue({ kind: 'api', api })
  }

  private enqueue(
    event: { kind: 'behavior'; behavior: BehaviorPayload } | { kind: 'api'; api: ApiPayload }
  ): void {
    // 单会话总量防风暴（超出静默丢弃，不丢主通道数据）
    if (this.count >= LIMITS.maxBehaviorPerSession) return
    this.count += 1
    const dsn = this.deps.getDsn()
    this.sender.add(dsn, event as unknown as Record<string, unknown>)
  }

  /** 测试观测：当前缓冲的行为事件数 */
  get pendingCount(): number {
    return this.sender.bufferedCount
  }

  /** 离场立即 flush（通道状态机 leaving 由 BatchSender 自理） */
  flushLeaving(payloads?: Array<{ dsn: string; data: unknown }>): void {
    void payloads
  }

  destroy(): void {
    this.destroyed = true
    this.sender.reset()
  }
}

/** 供 monitorClient.track() 使用的便捷构造（保持 track 语义与防风暴在同一处） */
export function sanitizeTrackPayload(
  name: string,
  props: Record<string, unknown> | undefined
): { name: string; props?: Record<string, unknown> } {
  if (!name || typeof name !== 'string') {
    logger.warn('track(name) 需要非空字符串')
    return { name: '' }
  }
  return { name: name.slice(0, LIMITS.behaviorName), props: sanitizeProps(props) }
}
