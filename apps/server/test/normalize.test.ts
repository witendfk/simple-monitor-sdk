/**
 * normalize 纯函数测试：kind 归一 / 截断兜底 / 服务端指纹 / 二次脱敏兜底
 */
import { describe, it, expect } from 'vitest'
import { PROTOCOL_VERSION, type TransportEnvelope } from '@simple-monitor/protocol'
import { computeFingerprint, fingerprintHash, normalizeEnvelope } from '../src/ingest/normalize'

type FingerprintInput = Parameters<typeof computeFingerprint>[0]

const envelopeFixture = (): TransportEnvelope => ({
  protocolVersion: PROTOCOL_VERSION,
  sentAt: 1759000000000,
  auth: {
    apiKey: 'k1',
    release: 'v1.0.0',
    env: 'production',
    sdk: { name: 'web', version: '0.0.1' },
  },
  session: { sessionId: 's1', trackerId: 't1' },
  context: { page: 'http://x.com/pay', device: { browser: 'chrome' } },
  events: [
    {
      kind: 'error',
      error: {
        type: 'JAVASCRIPT_ERROR',
        message: 'boom at checkout',
        name: 'TypeError',
        viewId: '/checkout/{param}',
        time: 1758999999000,
        stackFrames: [
          { url: 'http://x.com/app.js', func: 'submit', line: 42, column: 7 },
          { url: 'http://x.com/lib.js', func: 'wrap', line: 1, column: 1 },
        ],
      },
      breadcrumbs: [{ type: 'Click', category: 'user', data: '<button>提交</button>' }],
    },
    { kind: 'perf', metrics: [{ name: 'largest-contentful-paint', value: 1234.5 }] },
  ],
})

describe('fingerprintHash / computeFingerprint', () => {
  it('FNV 稳定：同输入同指纹', () => {
    expect(fingerprintHash('a|b|c')).toBe(fingerprintHash('a|b|c'))
    expect(fingerprintHash('a|b|c')).not.toBe(fingerprintHash('a|b|d'))
  })

  it('指纹含首帧位置：同 message 不同位置的错误分开分组', () => {
    const mk = (url: string, line: number) => ({
      type: 'JAVASCRIPT_ERROR',
      message: 'Cannot read property x of undefined',
      stackFrames: [{ url, func: 'f', line, column: 1 }],
    })
    const a = computeFingerprint(mk('app.js', 42) as unknown as FingerprintInput)
    const b = computeFingerprint(mk('app.js', 99) as unknown as FingerprintInput)
    expect(a).not.toBe(b)
  })

  it('无堆栈退化为 type+message 粒度（与 SDK errorId 对齐）', () => {
    const fp = computeFingerprint({ type: 'X', message: 'm' } as unknown as FingerprintInput)
    expect(fp).toBe(fingerprintHash('X|m|'))
  })
})

describe('normalizeEnvelope', () => {
  it('error 事件投影：指纹/面包屑/设备/会话维度齐全', () => {
    const { events, rejected } = normalizeEnvelope(envelopeFixture())
    expect(rejected).toBe(0)
    const errorEvent = events.find((e) => e.kind === 'error')!
    expect(errorEvent.apikey).toBe('k1')
    expect(errorEvent.release).toBe('v1.0.0')
    expect(errorEvent.sessionId).toBe('s1')
    expect(errorEvent.viewId).toBe('/checkout/{param}')
    expect(errorEvent.error?.fingerprint).toBeTruthy()
    expect(errorEvent.error?.stackFrames).toHaveLength(2)
    expect(errorEvent.breadcrumbs?.[0].data).toBe('<button>提交</button>')
    expect(errorEvent.device).toEqual({ browser: 'chrome' })
  })

  it('perf 指标逐条落库（一行一指标）', () => {
    const { events } = normalizeEnvelope(envelopeFixture())
    const perfs = events.filter((e) => e.kind === 'perf')
    expect(perfs).toHaveLength(1)
    expect(perfs[0].type).toBe('largest-contentful-paint')
    expect(perfs[0].perf?.[0].value).toBe(1234.5)
  })

  it('超长 message 截断到 1KB（服务端兜底）', () => {
    const env = envelopeFixture()
    const errorEvent = env.events[0] as Extract<(typeof env.events)[number], { kind: 'error' }>
    errorEvent.error.message = 'x'.repeat(5000)
    const { events } = normalizeEnvelope(env)
    expect(events[0].error?.message.length).toBe(1024)
  })

  it('replay 事件暂不落明细（计数 rejected）', () => {
    const env = envelopeFixture()
    env.events = [{ kind: 'replay', rrweb: { events: [] }, reason: 'error' }]
    const { events, rejected } = normalizeEnvelope(env)
    expect(events).toHaveLength(0)
    expect(rejected).toBe(1)
  })
})

describe('二次脱敏兜底（§3.3 P0：不信任 SDK 出口，落库前统一遮蔽）', () => {
  it('行为/API/perf 明细：敏感原值全通道无残留，标识键与数值保留', () => {
    const env = envelopeFixture()
    env.events = [
      {
        kind: 'behavior',
        behavior: {
          behaviorType: 'page_view',
          url: '/pay?token=secret9&phone=13812345678',
          utmSource: 'nl',
        },
      },
      {
        kind: 'behavior',
        behavior: {
          behaviorType: 'track',
          name: 'submit_order',
          props: { phone: '13812345678', jwt: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def' },
          from: 'declarative',
        },
      },
      {
        kind: 'api',
        api: {
          method: 'GET',
          url: 'https://api.x.com/orders/1?token=secret9',
          status: 200,
          durationMs: 33,
          traceId: '1234567890abcdef1234567890abcdef',
        },
      },
      {
        kind: 'perf',
        metrics: [
          { name: 'navigation-timing', value: 2100, detail: { note: 'phone 13812345678' } },
        ],
      },
    ]
    const { events, rejected } = normalizeEnvelope(env)
    expect(rejected).toBe(0)
    const s = JSON.stringify(events)
    expect(s).not.toContain('13812345678')
    expect(s).not.toContain('secret9')
    expect(s).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(s).toContain('[phone]')
    const apiEvent = events.find((e) => e.kind === 'api')!
    expect((apiEvent.api as Record<string, unknown>).traceId).toBe(
      '1234567890abcdef1234567890abcdef'
    )
    expect((apiEvent.api as Record<string, unknown>).url).toBe('https://api.x.com/orders/1')
    const perfEvent = events.find((e) => e.kind === 'perf')!
    expect(perfEvent.perf?.[0].value).toBe(2100)
  })

  it('旧版 SDK 的 error 载荷（未脱敏）：message/帧/面包屑/http 落库前遮蔽，指纹基于脱敏文本', () => {
    const env = envelopeFixture()
    const rawError = (env.events[0] as { error: Record<string, unknown> }).error
    rawError.message = 'login failed: token=abc123 phone 13812345678'
    rawError.stackFrames = [
      { url: 'http://x.com/app.js?token=secret9', func: 'submit', line: 42, column: 7 },
    ]
    rawError.http = {
      method: 'POST',
      url: 'http://api.x.com/login?token=secret9',
      status: 401,
      traceId: 't-1234567890',
    }
    ;(env.events[0] as { breadcrumbs: Array<Record<string, unknown>> }).breadcrumbs = [
      { type: 'Console', category: 'debug', data: { pwd: 'hunter2' } },
    ]
    const { events } = normalizeEnvelope(env)
    const errorEvent = events.find((e) => e.kind === 'error')!
    const s = JSON.stringify(errorEvent)
    expect(s).not.toContain('abc123')
    expect(s).not.toContain('13812345678')
    expect(s).not.toContain('secret9')
    expect(s).not.toContain('hunter2')
    expect(errorEvent.error?.message).toContain('[credential]')
    // 标识键保留（10 位数字段不被数字串规则咬掉）
    expect(errorEvent.error?.http?.traceId).toBe('t-1234567890')
    // 指纹基于脱敏后文本计算（跨 SDK 版本分组稳定）
    expect(errorEvent.error?.fingerprint).toBe(
      computeFingerprint({
        type: 'JAVASCRIPT_ERROR',
        message: errorEvent.error!.message,
        stackFrames: errorEvent.error!.stackFrames,
      } as unknown as FingerprintInput)
    )
  })
})
