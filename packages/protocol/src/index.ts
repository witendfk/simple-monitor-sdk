/**
 * @simple-monitor/protocol —— 传输协议 v1（契约层）
 *
 * 单一事实来源：信封/事件 schema（zod）+ 推导类型 + 截断常量 + 协议版本。
 * 见 开发总纲.md §五（协议设计）与 §二 ADR-2（契约先行）。
 */
export { PROTOCOL_VERSION } from './version'
export { LIMITS } from './limits'
export {
  StackFrameSchema,
  HttpPayloadSchema,
  ErrorPayloadSchema,
  PerfMetricSchema,
  BreadcrumbSchema,
  BehaviorPayloadSchema,
  ApiPayloadSchema,
  EventSchema,
  TransportEnvelopeSchema,
  validateEnvelope,
  isErrorEvent,
  isPerfEvent,
  KNOWN_ERROR_TYPES,
  KNOWN_METRIC_NAMES,
} from './schema'
export type {
  StackFrame,
  HttpPayload,
  ErrorPayload,
  PerfMetric,
  Breadcrumb,
  BehaviorPayload,
  BehaviorEvent,
  ApiPayload,
  ApiEvent,
  MonitorEvent,
  ErrorEvent,
  PerfEvent,
  ReplayEvent,
  TransportEnvelope,
} from './schema'
