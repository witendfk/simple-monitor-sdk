/**
 * normalize 纯函数测试：kind 归一 / 截断兜底 / 服务端指纹
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
