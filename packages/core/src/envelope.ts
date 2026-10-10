/**
 * 协议信封构建（M2，docs/SPEC.md 协议 v1）
 *
 * SDK 内部数据（TransportDataType / PerformanceReportData）→ protocol v1 事件与信封。
 * 职责边界：只做转换与归一化，不做网络——发送/重试/缓存见 batchSender.ts。
 */
import type { BreadcrumbPushData, DeviceInfo, ReportDataType } from '@simple-monitor/types'
import { interceptStr, mask, sanitizePageUrl } from '@simple-monitor/utils'
import {
  LIMITS,
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
  /** 当前路由视图快照（信封级；错误事件另带采集时刻 viewId） */
  viewId?: string
  deviceInfo?: DeviceInfo
}

/** ReportDataType.stack 的帧形状（url/func/line/column，多余字段由 schema 剥离） */
function toStackFrames(stack: unknown): StackFrame[] | undefined {
  if (!Array.isArray(stack) || stack.length === 0) return undefined
  return stack.slice(0, 50).map((f: any) => ({
    // 帧 URL 是宿主可控文本（query 可能带凭证），出口统一遮蔽凭证
    url: typeof f?.url === 'string' ? mask(f.url) : null,
    func: typeof f?.func === 'string' ? f.func : null,
    line: typeof f?.line === 'number' ? f.line : null,
    column: typeof f?.column === 'number' ? f.column : null,
  }))
}

/**
 * 面包屑 data 的结构化脱敏（第四隐私入口兜底）：
 * 深遍历对象，**仅对字符串值**过 mask（凭证遮蔽）并截断——数值/布尔字段
 * （时间戳、耗时、状态码）原样保留，不再被文本 mask 的数字串规则误伤
 * （真实数据实证：13 位时间戳被打成 [card]）。
 */
function sanitizeBreadcrumbValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return interceptStr(mask(value), LIMITS.breadcrumbData)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= 3) return interceptStr(mask(String(value)), LIMITS.breadcrumbData)
  if (Array.isArray(value))
    return value.slice(0, 20).map((v) => sanitizeBreadcrumbValue(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
      out[k] = sanitizeBreadcrumbValue(v, depth + 1)
    }
    return out
  }
  return interceptStr(mask(String(value)), LIMITS.breadcrumbData)
}

function sanitizeBreadcrumbData(data: unknown): unknown {
  if (data === null || data === undefined) return undefined
  if (typeof data === 'string') return interceptStr(mask(data), LIMITS.breadcrumbData)
  if (typeof data !== 'object') return interceptStr(mask(String(data)), LIMITS.breadcrumbData)
  try {
    return sanitizeBreadcrumbValue(data)
  } catch {
    return '[unserializable]'
  }
}

function toBreadcrumbs(stack: BreadcrumbPushData[] | undefined): Breadcrumb[] | undefined {
  if (!stack || stack.length === 0) return undefined
  return stack.map((b) => ({
    type: String(b.type ?? ''),
    category: b.category ? String(b.category) : undefined,
    data: sanitizeBreadcrumbData(b.data),
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
          // 出口兜底脱敏：replace 层已 mask 过，手动上报等旁路进入的数据在此统一防线
          reqData:
            typeof data.request?.data === 'string'
              ? interceptStr(mask(data.request.data), LIMITS.httpBody)
              : undefined,
          responseText:
            typeof data.response?.data === 'string'
              ? interceptStr(mask(data.response.data), LIMITS.httpBody)
              : undefined,
        }
      : undefined
  return {
    kind: 'error',
    error: {
      type: String(data.type ?? 'UNKNOWN'),
      // message 是宿主 throw 的自由文本（可能含凭证）：先脱敏后截断——截断边界最多切坏标记本身，不泄原文
      message: interceptStr(mask(String(data.message ?? '')), LIMITS.message),
      name: data.name ? mask(String(data.name)) : undefined,
      level: data.level ? String(data.level) : undefined,
      time: typeof data.time === 'number' ? data.time : undefined,
      page: data.url ? sanitizePageUrl(String(data.url)) : undefined,
      stackFrames: toStackFrames(data.stack),
      errorId: typeof data.errorId === 'number' ? data.errorId : undefined,
      componentName: data.componentName ? String(data.componentName) : undefined,
      resourceKind: (data as { resourceKind?: 'script' | 'image' | 'css' | 'media' | 'other' })
        .resourceKind,
      customTag: data.customTag ? String(data.customTag) : undefined,
      viewId: data.viewId ? String(data.viewId) : undefined,
      http: http
        ? {
            ...http,
            // API URL 保留 query 的调试价值（哪个 id 失败），凭证经 mask 遮蔽
            url: http.url ? mask(http.url) : undefined,
          }
        : undefined,
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
    // 协议约束 score ∈ [0,1]：越界值会被服务端整信封拒收（连坐同批事件），此处钳制兜底
    score: score === null ? undefined : Math.min(1, Math.max(0, score)),
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
      viewId: ctx.viewId,
      device: toDeviceSnapshot(ctx.deviceInfo),
    },
    events,
  }
}
