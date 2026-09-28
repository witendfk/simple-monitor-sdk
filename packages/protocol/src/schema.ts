/**
 * 传输协议 v1 —— zod schema 为单一事实来源，TS 类型全部由 schema 推导。
 *
 * 消费方式（总纲 ADR-2）：
 *  - 服务端接收端：import schema（运行时校验）；
 *  - SDK 发送端：`import type` 只取类型（生产 build 将 zod 与 schema 全部摇树，
 *    运行时零依赖、零体积）。
 *
 * 演进纪律：只加可选字段 = 版本不变；删字段 / 改语义 = PROTOCOL_VERSION + 1。
 */
import { z } from 'zod'
import { LIMITS } from './limits'
import { PROTOCOL_VERSION } from './version'

/* ------------------------------------------------------------------ *
 * 公共片段
 * ------------------------------------------------------------------ */

/** 堆栈帧：字段与 utils/extractErrorStack 的解析产物对齐 */
export const StackFrameSchema = z.object({
  url: z.string().nullish(),
  func: z.string().nullish(),
  line: z.number().int().nullish(),
  column: z.number().int().nullish(),
})

/** HTTP 请求上下文（FETCH_ERROR / 后续 trace 关联用） */
export const HttpPayloadSchema = z.object({
  method: z.string().optional(),
  url: z.string().optional(),
  status: z.number().int().optional(),
  /** 请求耗时 ms（status=0 时 SDK 用它区分跨域/超时） */
  elapsedTime: z.number().optional(),
  /** traceparent 追踪标识（ADR-7） */
  traceId: z.string().optional(),
  reqData: z.string().optional(),
  responseText: z.string().optional(),
})

/**
 * 已知错误类型（与 SDK ErrorTypes 的 wire 值对齐，注意 FETCH_ERROR 的值是 'HTTP_ERROR'）。
 * 仅作文档与看板分组参考；schema 校验为开放 string，保证向前兼容。
 */
export const KNOWN_ERROR_TYPES = [
  'JAVASCRIPT_ERROR',
  'PROMISE_ERROR',
  'HTTP_ERROR',
  'RESOURCE_ERROR',
  'VUE_ERROR',
  'REACT_ERROR',
  'LOG_ERROR',
  'ROUTE_ERROR',
  'UNKNOWN',
] as const

/** 错误事件载荷 */
export const ErrorPayloadSchema = z.object({
  /** 错误类型，已知值见 KNOWN_ERROR_TYPES */
  type: z.string(),
  message: z.string(),
  name: z.string().optional(),
  level: z.string().optional(),
  /** 客户端发生时间戳 ms（离线重放场景区分 sentAt） */
  time: z.number().optional(),
  /** 出错页面 URL（SDK 端 getRealPath 归一后） */
  page: z.string().optional(),
  stackFrames: z.array(StackFrameSchema).max(LIMITS.maxStackFrames).optional(),
  /** SDK 流量去重指纹（hashCode 数字）；服务端自算 fingerprint 做分析分组，见总纲 §五规格 1 */
  errorId: z.number().optional(),
  componentName: z.string().optional(),
  customTag: z.string().optional(),
  http: HttpPayloadSchema.optional(),
})

/**
 * 性能指标。value 一律为 number（总纲 §3.1 红线：杜绝 INP 曾把对象塞进 value 的问题），
 * 富信息放 detail 平级可选字段；已知指标名见 KNOWN_METRIC_NAMES。
 */
export const PerfMetricSchema = z.object({
  name: z.string(),
  value: z.number(),
  unit: z.enum(['ms', 'count', 'ratio', 'fps']).optional(),
  /** Chrome 对数正态模型好度分 0~1（可选，未配置评分的指标缺省） */
  score: z.number().min(0).max(1).optional(),
  /** 富信息平级字段：INP 交互明细 / NT 阶段拆解 / RT slowTop 等 */
  detail: z.record(z.string(), z.unknown()).optional(),
})

/** 已知性能指标名（与 web-performance metricsName 的 wire 值对齐），仅作文档参考 */
export const KNOWN_METRIC_NAMES = [
  'navigation-timing',
  'first-paint',
  'first-contentful-paint',
  'largest-contentful-paint',
  'custom-contentful-paint',
  'interaction-to-next-paint',
  'resource-timing',
  'cumulative-layout-shift',
  'fps',
  'api-complete-time',
] as const

/** 面包屑（用户行为）单条 */
export const BreadcrumbSchema = z.object({
  /** 已知值：xhr / fetch / click / route / console / code-error / resource / vue / react / customer */
  type: z.string(),
  /** http | user | debug | lifecycle | exception */
  category: z.string().optional(),
  data: z.unknown(),
  level: z.string().optional(),
  time: z.number().optional(),
})

/* ------------------------------------------------------------------ *
 * 事件判别联合
 * ------------------------------------------------------------------ */

export const EventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('error'),
    error: ErrorPayloadSchema,
    /** 出错现场行为栈（随错误上报；面包屑型数据不单独成事件） */
    breadcrumbs: z.array(BreadcrumbSchema).max(LIMITS.maxBreadcrumbs).optional(),
  }),
  z.object({
    kind: z.literal('perf'),
    metrics: z.array(PerfMetricSchema).min(1).max(LIMITS.maxMetricsPerEvent),
  }),
  z.object({
    kind: z.literal('replay'),
    /** rrweb 事件流快照（M6 实装；协议先占位，保证信封结构稳定） */
    rrweb: z.object({ events: z.array(z.unknown()) }),
    reason: z.literal('error').optional(),
  }),
])

/* ------------------------------------------------------------------ *
 * 信封：一次网络请求的传输单元
 * ------------------------------------------------------------------ */

export const TransportEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  /** SDK 发送时刻 ms（离线重放时与 event 内 time / 服务端 receiveAt 三方对照） */
  sentAt: z.number(),
  auth: z.object({
    apiKey: z.string().min(1),
    release: z.string().optional(),
    env: z.string().optional(),
    sdk: z.object({
      name: z.string(),
      version: z.string(),
    }),
  }),
  session: z.object({
    /** 会话标识：sessionStorage 级，关标签页失效 */
    sessionId: z.string().min(1),
    /** 用户标识：localStorage 级，跨会话稳定 */
    trackerId: z.string().min(1),
  }),
  context: z.object({
    page: z.string(),
    referrer: z.string().optional(),
    viewport: z.string().optional(),
    /** SPA 路由级标识（M3），错误/性能事件可关联到具体路由视图 */
    viewId: z.string().optional(),
  }),
  events: z.array(EventSchema).min(1).max(LIMITS.maxEventsPerEnvelope),
})

/* ------------------------------------------------------------------ *
 * 类型推导（唯一类型出口，SDK/服务端禁止自行手写 wire 类型）
 * ------------------------------------------------------------------ */

export type StackFrame = z.infer<typeof StackFrameSchema>
export type HttpPayload = z.infer<typeof HttpPayloadSchema>
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>
export type PerfMetric = z.infer<typeof PerfMetricSchema>
export type Breadcrumb = z.infer<typeof BreadcrumbSchema>
export type MonitorEvent = z.infer<typeof EventSchema>
export type ErrorEvent = Extract<MonitorEvent, { kind: 'error' }>
export type PerfEvent = Extract<MonitorEvent, { kind: 'perf' }>
export type ReplayEvent = Extract<MonitorEvent, { kind: 'replay' }>
export type TransportEnvelope = z.infer<typeof TransportEnvelopeSchema>

/* ------------------------------------------------------------------ *
 * 便捷校验入口
 * ------------------------------------------------------------------ */

/** 不抛错的信封校验（服务端 /report 接收端用；SDK 生产 build 不引用本文件） */
export function validateEnvelope(input: unknown): z.SafeParseReturnType<unknown, TransportEnvelope> {
  return TransportEnvelopeSchema.safeParse(input)
}

export function isErrorEvent(event: MonitorEvent): event is ErrorEvent {
  return event.kind === 'error'
}

export function isPerfEvent(event: MonitorEvent): event is PerfEvent {
  return event.kind === 'perf'
}
