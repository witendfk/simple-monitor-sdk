/* eslint-disable @typescript-eslint/no-explicit-any -- 测试构造协议信封的脏数据场景豁免 */
import { describe, it, expect } from 'vitest'
import {
  PROTOCOL_VERSION,
  LIMITS,
  KNOWN_ERROR_TYPES,
  TransportEnvelopeSchema,
  validateEnvelope,
  isErrorEvent,
  isPerfEvent,
  type TransportEnvelope,
} from '../../packages/protocol/src'

/** 构造一份合法信封（测试工厂，字段与总纲 §五 schema 一一对应） */
const validEnvelope = (): TransportEnvelope => ({
  protocolVersion: PROTOCOL_VERSION,
  sentAt: 1759000000000,
  auth: {
    apiKey: 'test-key',
    release: 'v1.0.0',
    env: 'production',
    sdk: { name: '@simple-monitor/web', version: '0.0.1' },
  },
  session: { sessionId: 'sess-1', trackerId: 'track-1' },
  context: { page: 'http://x.com/detail/{param}', viewId: '/detail' },
  events: [
    {
      kind: 'error',
      error: {
        type: 'JAVASCRIPT_ERROR',
        message: 'boom',
        name: 'Error',
        level: 'Normal',
        time: 1759000000000,
        page: 'http://x.com/detail/{param}',
        stackFrames: [{ url: 'http://x.com/app.js', func: 'doThing', line: 10, column: 20 }],
        errorId: 12345,
        http: { method: 'GET', url: 'http://x.com/api/1', status: 500, elapsedTime: 120 },
      },
      breadcrumbs: [{ type: 'click', category: 'user', data: '<button>提交</button>', time: 1 }],
    },
  ],
})

describe('protocol v1（M0 契约）', () => {
  it('协议版本为 1，LIMITS 与总纲 §五规格一致', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(LIMITS.message).toBe(1024)
    expect(LIMITS.httpBody).toBe(2048)
    expect(LIMITS.breadcrumbData).toBe(512)
    expect(LIMITS.maxStackFrames).toBe(50)
    expect(LIMITS.maxBreadcrumbs).toBe(50)
    expect(LIMITS.maxMetricsPerEvent).toBe(200)
    expect(LIMITS.maxEventsPerEnvelope).toBe(100)
  })

  it('KNOWN_ERROR_TYPES 记录 FETCH_ERROR 的 wire 值是 HTTP_ERROR（历史命名坑）', () => {
    expect(KNOWN_ERROR_TYPES).toContain('HTTP_ERROR')
  })

  it('合法信封：error 事件（含堆栈/面包屑/http 上下文）通过校验', () => {
    expect(TransportEnvelopeSchema.safeParse(validEnvelope()).success).toBe(true)
  })

  it('合法信封：perf 事件（value 一律 number + detail 富信息平级）通过校验', () => {
    const envelope = validEnvelope()
    envelope.events = [
      {
        kind: 'perf',
        metrics: [
          { name: 'largest-contentful-paint', value: 1234.56, unit: 'ms', score: 0.87 },
          // 红线回归位：INP 的交互明细放 detail，而不是混进 value
          {
            name: 'interaction-to-next-paint',
            value: 88,
            unit: 'ms',
            detail: { eventName: 'click' },
          },
        ],
      },
    ]
    const result = TransportEnvelopeSchema.safeParse(envelope)
    expect(result.success).toBe(true)
  })

  it('合法信封：replay 事件（rrweb 占位）通过校验', () => {
    const envelope = validEnvelope()
    envelope.events = [{ kind: 'replay', rrweb: { events: [{ type: 2 }] }, reason: 'error' }]
    expect(TransportEnvelopeSchema.safeParse(envelope).success).toBe(true)
  })

  it('红线：perf metric 的 value 为字符串/对象时拒绝（§3.1 类型不一问题在 schema 层终结）', () => {
    const envelope = validEnvelope()
    envelope.events = [{ kind: 'perf', metrics: [{ name: 'x', value: '88' } as any] }]
    expect(TransportEnvelopeSchema.safeParse(envelope).success).toBe(false)

    envelope.events = [{ kind: 'perf', metrics: [{ name: 'x', value: { duration: 88 } } as any] }]
    expect(TransportEnvelopeSchema.safeParse(envelope).success).toBe(false)
  })

  it('拒绝：protocolVersion 错误 / apiKey 为空 / events 为空 / 未知 kind / 缺 session', () => {
    expect(
      TransportEnvelopeSchema.safeParse({ ...validEnvelope(), protocolVersion: 2 }).success
    ).toBe(false)
    expect(
      TransportEnvelopeSchema.safeParse({
        ...validEnvelope(),
        auth: { ...validEnvelope().auth, apiKey: '' },
      }).success
    ).toBe(false)
    expect(TransportEnvelopeSchema.safeParse({ ...validEnvelope(), events: [] }).success).toBe(
      false
    )
    expect(
      TransportEnvelopeSchema.safeParse({ ...validEnvelope(), events: [{ kind: 'track' } as any] })
        .success
    ).toBe(false)
    const noSession = { ...validEnvelope() } as any
    delete noSession.session
    expect(TransportEnvelopeSchema.safeParse(noSession).success).toBe(false)
  })

  it('拒绝：结构超限（面包屑 > 50 / 事件 > 100 / 指标 > 200）', () => {
    const manyBreadcrumbs = Array.from({ length: LIMITS.maxBreadcrumbs + 1 }, (_, i) => ({
      type: 'click',
      data: i,
    }))
    expect(
      TransportEnvelopeSchema.safeParse({
        ...validEnvelope(),
        events: [
          { kind: 'error', error: validEnvelope().events[0] as any, breadcrumbs: manyBreadcrumbs },
        ],
      }).success
    ).toBe(false)

    const manyEvents = Array.from({ length: LIMITS.maxEventsPerEnvelope + 1 }, () => ({
      kind: 'perf',
      metrics: [{ name: 'fps', value: 60 }],
    }))
    expect(
      TransportEnvelopeSchema.safeParse({ ...validEnvelope(), events: manyEvents }).success
    ).toBe(false)

    const manyMetrics = Array.from({ length: LIMITS.maxMetricsPerEvent + 1 }, () => ({
      name: 'fps',
      value: 60,
    }))
    expect(
      TransportEnvelopeSchema.safeParse({
        ...validEnvelope(),
        events: [{ kind: 'perf', metrics: manyMetrics }],
      }).success
    ).toBe(false)
  })

  it('validateEnvelope 返回 safeParse 结果，不抛错', () => {
    expect(validateEnvelope(validEnvelope()).success).toBe(true)
    expect(validateEnvelope({ nope: true }).success).toBe(false)
  })

  it('类型守卫：isErrorEvent / isPerfEvent', () => {
    const envelope = validEnvelope()
    envelope.events = [
      { kind: 'error', error: { type: 'JAVASCRIPT_ERROR', message: 'm' } },
      { kind: 'perf', metrics: [{ name: 'fps', value: 60 }] },
    ]
    const [e1, e2] = TransportEnvelopeSchema.parse(envelope).events
    expect(isErrorEvent(e1)).toBe(true)
    expect(isPerfEvent(e2)).toBe(true)
    expect(isErrorEvent(e2)).toBe(false)
  })
})

describe('protocol v1.1 行为域（M7 ADR-8 加性扩展）', () => {
  const base = () => ({
    protocolVersion: PROTOCOL_VERSION,
    sentAt: Date.now(),
    auth: { apiKey: 'k', sdk: { name: 'web', version: '0.0.1' } },
    session: { sessionId: 's', trackerId: 't' },
    context: { page: 'http://x/orders' },
  })

  it('kind behavior：四类 behaviorType 全部通过', () => {
    const envelope = {
      ...base(),
      events: [
        {
          kind: 'behavior',
          behavior: { behaviorType: 'page_view', url: '/orders', loadType: 'navigate' },
        },
        {
          kind: 'behavior',
          behavior: { behaviorType: 'page_dwell', activeMs: 5200, startTime: 1, endTime: 5201 },
        },
        {
          kind: 'behavior',
          behavior: {
            behaviorType: 'expose',
            name: 'pay-btn',
            selector: '[data-expose="pay-btn"]',
            dwellMs: 500,
          },
        },
        {
          kind: 'behavior',
          behavior: {
            behaviorType: 'track',
            name: 'pay_click',
            from: 'declarative',
            props: { amount: 100 },
          },
        },
      ],
    }
    const r = validateEnvelope(envelope)
    expect(r.success).toBe(true)
    expect(r.success && r.data.events).toHaveLength(4)
  })

  it('kind api：成功请求明细通过；behavior 名超长被拒（LIMITS）', () => {
    expect(
      validateEnvelope({
        ...base(),
        events: [
          {
            kind: 'api',
            api: { method: 'POST', url: '/api/orders', status: 201, durationMs: 45, slow: false },
          },
        ],
      }).success
    ).toBe(true)
    expect(
      validateEnvelope({
        ...base(),
        events: [
          {
            kind: 'behavior',
            behavior: { behaviorType: 'track', name: 'x'.repeat(200), from: 'api' },
          },
        ],
      }).success
    ).toBe(false)
  })

  it('behavior track props 键数超限被拒（LIMITS.trackPropsKeys）', () => {
    const props = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))
    expect(
      validateEnvelope({
        ...base(),
        events: [
          { kind: 'behavior', behavior: { behaviorType: 'track', name: 'x', from: 'api', props } },
        ],
      }).success
    ).toBe(false)
  })
})
