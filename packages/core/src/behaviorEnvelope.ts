/**
 * 行为域信封构建（M7，ADR-8 加性扩展）
 *
 * 行为/api 事件走**独立信封**与独立发送实例（不与 error/perf 混组）——
 * 旧服务端不支持 behavior/api kind 时 400 只丢行为组，错误/性能主通道不受牵连。
 */
import type {
  BehaviorPayload,
  ApiPayload,
  MonitorEvent,
  TransportEnvelope,
} from '@simple-monitor/protocol'
import type { DeviceInfo } from '@simple-monitor/types'
import { PROTOCOL_VERSION, PROTOCOL_VERSION as PV } from '@simple-monitor/protocol'
import { maskDeep, stripUrlQuery } from '@simple-monitor/utils'

/**
 * 行为/api 事件的出口隐私清洗（协议出口兜底，三入口之外的第 4-5 隐私入口）：
 *  - PV url 与成功请求 url 剥 query/hash（token/用户标识藏身处；页面与 API 聚合都按路径语义，
 *    error.http.url 不走此策略——那边的约定是遮蔽凭证、保留 query）；
 *  - 其余嵌套字符串（声明式/代码埋点 props 等）过 maskDeep 遮蔽+截断，traceId 等标识键保留。
 * 返回新对象不改写入参——载荷仍在 BehaviorTracker 缓冲中，失败重试会复用。
 */
function sanitizeEgress(
  payloads: Array<
    { kind: 'behavior'; behavior: BehaviorPayload } | { kind: 'api'; api: ApiPayload }
  >
): MonitorEvent[] {
  const cleaned = payloads.map((p) => {
    if (p.kind === 'api') {
      return { kind: 'api', api: { ...p.api, url: stripUrlQuery(p.api.url) } } as MonitorEvent
    }
    const behavior = p.behavior
    if (behavior.behaviorType === 'page_view') {
      return {
        kind: 'behavior',
        behavior: { ...behavior, url: stripUrlQuery(behavior.url) },
      } as MonitorEvent
    }
    return { kind: 'behavior', behavior } as MonitorEvent
  })
  return maskDeep(cleaned) as MonitorEvent[]
}

/** 行为信封上下文（与 EnvelopeContext 同源，由 TransportData/MonitorClient 提供） */
export interface BehaviorEnvelopeContext {
  apiKey: string
  release?: string
  env?: string
  sdkName: string
  sdkVersion: string
  sessionId: string
  trackerId: string
  page: string
  viewId?: string
  deviceInfo?: DeviceInfo
}

/** 设备快照（与 envelope.toDeviceSnapshot 同规则，此处独立避免循环耦合） */
function deviceSnapshot(deviceInfo?: DeviceInfo): Record<string, string> | undefined {
  if (!deviceInfo || typeof deviceInfo !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(deviceInfo)) {
    if (v !== null && v !== undefined && typeof v !== 'object') out[k] = String(v)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 行为/api 载荷 → 独立信封（payloads 可混合 behavior 与 api 两种 kind） */
export function buildBehaviorEnvelope(
  ctx: BehaviorEnvelopeContext,
  payloads: Array<
    { kind: 'behavior'; behavior: BehaviorPayload } | { kind: 'api'; api: ApiPayload }
  >
): TransportEnvelope {
  const events = sanitizeEgress(payloads)
  return {
    protocolVersion: PROTOCOL_VERSION ?? PV,
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
      viewId: ctx.viewId,
      device: deviceSnapshot(ctx.deviceInfo),
    },
    events,
  }
}
