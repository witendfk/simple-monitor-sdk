/**
 * 行为/api 信封出口隐私测试（§3.3 P0）：PV/成功请求 URL 剥 query、
 * 声明式与代码埋点 props 深度脱敏、traceId 等标识键保留。
 * BatchSender 的 IndexedDB 缓存存的是本出口产物，网络载荷与缓存同吃。
 */
import { describe, it, expect } from 'vitest'
import { buildBehaviorEnvelope } from '../../packages/core/src/behaviorEnvelope'
import { validateEnvelope } from '@simple-monitor/protocol'

const ctx = {
  apiKey: 'k',
  release: 'v0.1.0',
  env: 'test',
  sdkName: 'test',
  sdkVersion: '0.0.1',
  sessionId: 'sess-1',
  trackerId: 'track-1',
  page: '/orders',
  viewId: '/orders',
}

describe('buildBehaviorEnvelope 出口兜底脱敏', () => {
  it('PV url 剥 query/hash（带 token 的 URL 不外泄），UTM 归因字段保留', () => {
    const envelope = buildBehaviorEnvelope(ctx, [
      {
        kind: 'behavior',
        behavior: {
          behaviorType: 'page_view',
          url: '/checkout?token=secret9&utm_source=nl#step2',
          utmSource: 'nl',
        },
      },
    ])
    const pv = (envelope.events[0] as { behavior: Record<string, unknown> }).behavior
    expect(pv.url).toBe('/checkout')
    expect(pv.url).not.toContain('secret9')
    expect(pv.utmSource).toBe('nl')
    expect(validateEnvelope(envelope).success).toBe(true)
  })

  it('埋点 props 深度脱敏：手机号、JWT 无原值（data-track-props 旁路同此出口）', () => {
    const envelope = buildBehaviorEnvelope(ctx, [
      {
        kind: 'behavior',
        behavior: {
          behaviorType: 'track',
          name: 'submit_order',
          props: { phone: '13812345678', auth: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def' },
          from: 'declarative',
        },
      },
    ])
    const s = JSON.stringify(envelope.events)
    expect(s).not.toContain('13812345678')
    expect(s).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(s).toContain('[phone]')
    expect(s).toContain('[credential]')
  })

  it('成功 API：url 剥 query，traceId/method/status/duration 保留', () => {
    const envelope = buildBehaviorEnvelope(ctx, [
      {
        kind: 'api',
        api: {
          method: 'GET',
          url: 'https://api.x.com/orders/42?token=secret9',
          status: 200,
          durationMs: 88,
          traceId: '1234567890abcdef1234567890abcdef',
        },
      },
    ])
    const api = (envelope.events[0] as { api: Record<string, unknown> }).api
    expect(api.url).toBe('https://api.x.com/orders/42')
    expect(api.url).not.toContain('secret9')
    expect(api.traceId).toBe('1234567890abcdef1234567890abcdef')
    expect(api).toMatchObject({ method: 'GET', status: 200, durationMs: 88 })
  })

  it('出口幂等：同一载荷重建信封结果一致（失败重试/缓冲复用安全）', () => {
    const payload = {
      kind: 'behavior' as const,
      behavior: {
        behaviorType: 'track' as const,
        name: 'n',
        props: { a: '[phone]' },
        from: 'api' as const,
      },
    }
    const once = buildBehaviorEnvelope(ctx, [payload])
    const twice = buildBehaviorEnvelope(ctx, [payload])
    expect(twice.events).toEqual(once.events)
  })
})
