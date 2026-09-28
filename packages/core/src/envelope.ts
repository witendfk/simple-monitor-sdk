/**
 * 协议信封构建（M2，总纲 §五）
 *
 * SDK 内部数据（TransportDataType / PerformanceReportData）→ protocol v1 事件与信封。
 * 职责边界：只做转换与归一化，不做网络——发送/重试/缓存见 batchSender.ts。
 */
import type { BreadcrumbPushData, DeviceInfo, ReportDataType } from '@simple-monitor/types'
import {
  PROTOCOL_VERSION,
  type Breadcrumb,
  type ErrorEvent,
  type MonitorEvent,
  type PerfEvent,
  type PerfMetric,
  type StackFrame,
  type TransportEnvelope,
} from '@simple-monitor/protocol'

/** 信封构建所需的上下文（由 TransportData 提供自身状态） */
export interface EnvelopeContext {
  apiKey: string
  release?: string
  env?: string
  sdkName: string
  sdkVersion: string
  sessionId: string
  trackerId: string
  page: string
  referrer?: string
  viewport?: string
  deviceInfo?: DeviceInfo
}

/** ReportDataType.stack 的帧形状（url/func/line/column，多余字段由 schema 剥离） */
function toStackFrames(stack: unknown): StackFrame[] | undefined {
  if (!Array.isArray(stack) || stack.length === 0) return undefined
  return stack.slice(0, 50).map((f: any) => ({
    url: typeof f?.url === 'string' ? f.url : null,
    func: typeof f?.func === 'string' ? f.func : null,
    line: typeof f?.line === 'number' ? f.line : null,
    column: typeof f?.column === 'number' ? f.column : null,
  }))
}

function toBreadcrumbs(stack: BreadcrumbPushData[] | undefined): Breadcrumb[] | undefined {
  if (!stack || stack.length === 0) return undefined
  return stack.map((b) => ({
    type: String(b.type ?? ''),
    category: b.category ? String(b.category) : undefined,
    data: b.data,
    level: b.level ? String(b.level) : undefined,
    time: typeof b.time === 'number' ? b.time : undefined,
  }))
}

/** 错误数据 → error 事件 */
export function toErrorEvent(data: ReportDataType, breadcrumbs?: BreadcrumbPushData[]): ErrorEvent {
  const http =
    data.request || data.response
      ? {
          method: data.request?.method,
          url: data.request?.url,
          status: data.response?.status,
          elapsedTime: data.elapsedTime,
          traceId: data.request?.traceId,
          reqData: typeof data.request?.data === 'string' ? data.request.data : undefined,
          responseText: typeof data.response?.data === 'string' ? data.response.data : undefined,
        }
      : undefined
  return {
    kind: 'error',
    error: {
      type: String(data.type ?? 'UNKNOWN'),
      message: String(data.message ?? ''),
      name: data.name ? String(data.name) : undefined,
      level: data.level ? String(data.level) : undefined,
      time: typeof data.time === 'number' ? data.time : undefined,
      page: data.url ? String(data.url) : undefined,
      stackFrames: toStackFrames(data.stack),
      errorId: typeof data.errorId === 'number' ? data.errorId : undefined,
      componentName: data.componentName ? String(data.componentName) : undefined,
      customTag: data.customTag ? String(data.customTag) : undefined,
      http,
    },
    breadcrumbs: toBreadcrumbs(breadcrumbs),
  }
}

/** 对象型指标的数值主值提取表（§3.1 红线：value 一律 number，结构化信息进 detail） */
const NUMERIC_MAIN_VALUE: Record<string, (v: any) => number | null> = {
  'navigation-timing': (v) => (typeof v?.pageLoad === 'number' ? v.pageLoad : null),
  'resource-timing': (v) =>
    Array.isArray(v?.slowTop)
      ? typeof v.slowTop[0]?.duration === 'number'
        ? v.slowTop[0].duration
        : 0
      : null,
  'api-complete-time': (v) => (typeof v?.time === 'number' ? v.time : null),
  'interaction-to-next-paint': (v) => (typeof v?.duration === 'number' ? v.duration : null),
}

function toNumber(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

/** 单个指标 → PerfMetric（无法提取数值主值的指标跳过，不造假数） */
export function toPerfMetric(name: string, raw: unknown): PerfMetric | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { name, value: raw } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const v = raw as { value?: unknown; score?: unknown }
  const detailSource = v
  // 指标自带数值主值（IMetrics { value, score }）
  let value = toNumber(v.value)
  const score = toNumber(v.score)
  // 结构化对象：从已知表提取主值，整体进 detail
  if (value === null) {
    const extractor = NUMERIC_MAIN_VALUE[name]
    value = extractor ? extractor(raw) : null
    if (value === null && typeof (raw as any)?.value === 'object') {
      // 嵌套 { value: obj }（如 ACT/INP 的对象值），尝试其内部
      const inner = (raw as any)?.value
      value = typeof inner === 'object' ? (extractor?.(inner) ?? null) : null
    }
  }
  if (value === null) return null
  return {
    name,
    value,
    score: score ?? undefined,
    detail:
      detailSource && Object.keys(detailSource).length > 0
        ? (detailSource as Record<string, unknown>)
        : undefined,
  }
}

/** 性能上报（Record<name, value|{value,score}|结构化对象>）→ perf 事件 */
export function toPerfEvent(metrics: Record<string, unknown>): PerfEvent | null {
  const list: PerfMetric[] = []
  for (const [name, raw] of Object.entries(metrics)) {
    const m = toPerfMetric(name, raw)
    if (m) list.push(m)
  }
  return list.length > 0 ? { kind: 'perf', metrics: list } : null
}

/** 设备信息 → 字符串化快照（协议 context.device） */
export function toDeviceSnapshot(deviceInfo?: DeviceInfo): Record<string, string> | undefined {
  if (!deviceInfo || typeof deviceInfo !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(deviceInfo)) {
    if (v !== null && v !== undefined && typeof v !== 'object') {
      out[k] = String(v)
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 组装完整信封（protocol v1） */
export function buildEnvelope(ctx: EnvelopeContext, events: MonitorEvent[]): TransportEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sentAt: Date.now(),
    auth: {
      apiKey: ctx.apiKey,
      release: ctx.release,
      env: ctx.env,
      sdk: { name: ctx.sdkName, version: ctx.sdkVersion },
    },
    session: { sessionId: ctx.sessionId, trackerId: ctx.trackerId },
    context: {
      page: ctx.page,
      referrer: ctx.referrer,
      viewport: ctx.viewport,
      device: toDeviceSnapshot(ctx.deviceInfo),
    },
    events,
  }
}
