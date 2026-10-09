/**
 * 归一化（总纲 §6.2 步骤 4）：清洗 / 归一 / 截断 / 服务端指纹。
 *
 * 纯函数、无 IO——与队列和存储解耦，可独立单测。
 * 职责：
 *  1. kind 归一（error/perf/replay，判别联合在协议 schema 已保证形状）；
 *  2. 字段白名单（协议 zod 校验已拦截未知形状，此处做落库投影）；
 *  3. 二次截断兜底（SDK 版本旧/未截断场景：message 1KB / 堆栈 32KB / 面包屑 512B×50）；
 *  4. 服务端 fingerprint：type + message + 堆栈首帧位置——分析精度高于
 *     SDK 的 message 级 errorId（流量侧粗、分析侧细，两层分工）。
 */
import type { TransportEnvelope, ErrorEvent, StackFrame } from '@simple-monitor/protocol'
import { LIMITS } from '@simple-monitor/protocol'

/** 落库事件（存储契约的输入形状，与 ClickHouse events 表一一对应） */
export interface NormalizedEvent {
  kind: 'error' | 'perf' | 'replay' | 'behavior' | 'api'
  type: string
  /** 客户端事件时间（协议 time / sentAt 兜底） */
  ts: Date
  apikey: string
  release?: string
  env?: string
  sdkName: string
  sdkVersion: string
  sessionId: string
  trackerId: string
  page: string
  viewId?: string
  device: Record<string, string>
  /** error 专属 */
  error?: {
    message: string
    name?: string
    level?: string
    errorId?: number
    /** 服务端指纹（首帧位置），错误分组主键 */
    fingerprint: string
    componentName?: string
    stackFrames: StackFrame[]
    http?: {
      method?: string
      url?: string
      status?: number
      elapsedTime?: number
      traceId?: string
    }
  }
  breadcrumbs?: Array<{
    type: string
    category?: string
    data?: unknown
    level?: string
    time?: number
  }>
  /** perf 专属 */
  perf?: Array<{ name: string; value: number; score?: number; detail?: Record<string, unknown> }>
  /** 行为域明细（M7 kind behavior） */
  behavior?: Record<string, unknown>
  /** 成功请求明细（M7 kind api） */
  api?: Record<string, unknown>
}

export interface NormalizeResult {
  events: NormalizedEvent[]
  /** 校验通过但归一后无有效内容的载荷（计数观测用，不入死信——协议已拦截大部分） */
  rejected: number
}

const MESSAGE_MAX = LIMITS.message
const STACK_FRAMES_MAX = LIMITS.maxStackFrames
const BREADCRUMBS_MAX = LIMITS.maxBreadcrumbs

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/** FNV-1a 32 位 → hex（比 SDK 的 java hashCode 冲突率低一个量级） */
export function fingerprintHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 服务端错误指纹：type + message + 堆栈首帧位置。
 * 无堆栈时退化为 type + message（与 SDK 粒度对齐）。
 */
export function computeFingerprint(error: ErrorEvent['error']): string {
  const first = error.stackFrames?.[0]
  const location = first?.url ? `${first.url}:${first.line ?? '?'}:${first.column ?? '?'}` : ''
  return fingerprintHash(`${error.type}|${error.message}|${location}`)
}

export function normalizeEnvelope(envelope: TransportEnvelope): NormalizeResult {
  const events: NormalizedEvent[] = []
  let rejected = 0

  for (const event of envelope.events) {
    const base = {
      apikey: envelope.auth.apiKey,
      release: envelope.auth.release,
      env: envelope.auth.env,
      sdkName: envelope.auth.sdk.name,
      sdkVersion: envelope.auth.sdk.version,
      sessionId: envelope.session.sessionId,
      trackerId: envelope.session.trackerId,
      page: envelope.context.page,
      viewId: undefined, // 事件级 viewId 在分支内覆盖
      device: envelope.context.device ?? {},
    }

    if (event.kind === 'error') {
      const message = truncate(event.error.message || '(empty)', MESSAGE_MAX)
      events.push({
        ...base,
        viewId: event.error.viewId ?? base.viewId,
        kind: 'error',
        type: event.error.type,
        ts: new Date(event.error.time ?? envelope.sentAt),
        error: {
          message,
          name: event.error.name,
          level: event.error.level,
          errorId: event.error.errorId,
          fingerprint: computeFingerprint(event.error),
          componentName: event.error.componentName,
          stackFrames: (event.error.stackFrames ?? []).slice(0, STACK_FRAMES_MAX),
          http: event.error.http,
        },
        breadcrumbs: (event.breadcrumbs ?? []).slice(0, BREADCRUMBS_MAX),
      })
    } else if (event.kind === 'behavior') {
      // 行为域（M7 ADR-8）：PV/停留/曝光/埋点 白名单入库
      const b = event.behavior
      events.push({
        ...base,
        viewId: base.viewId,
        kind: 'behavior',
        type: b.behaviorType,
        ts: new Date(envelope.sentAt),
        behavior: b as unknown as Record<string, unknown>,
      })
    } else if (event.kind === 'api') {
      // 成功请求明细（M7 ADR-8 kind api）
      events.push({
        ...base,
        kind: 'api',
        type: 'api',
        ts: new Date(envelope.sentAt),
        api: { ...event.api } as unknown as Record<string, unknown>,
      })
    } else if (event.kind === 'perf') {
      for (const metric of event.metrics) {
        // perf 指标逐条落库（协议保证 value 为有限 number）
        events.push({
          ...base,
          kind: 'perf',
          type: metric.name,
          ts: new Date(envelope.sentAt),
          perf: [
            {
              name: metric.name,
              value: metric.value,
              score: metric.score,
              detail: metric.detail,
            },
          ],
        })
      }
    } else {
      // replay：M6 实装；协议已占位，此处仅接受不落明细（计数）
      rejected += 1
    }
  }

  return { events, rejected }
}
