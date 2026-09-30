/* eslint-disable @typescript-eslint/no-explicit-any -- 测试替身与脏数据构造场景豁免（对齐 batchSenderHardening 先例） */
/**
 * 协议信封构建测试（M2）：归一化红线（value=number）+ 错误事件映射 + 信封组装
 */
import { describe, it, expect } from 'vitest'
import { ErrorTypes } from '@simple-monitor/types'
import { toErrorEvent, toPerfEvent, toPerfMetric, buildEnvelope } from '@simple-monitor/core'
import { validateEnvelope } from '@simple-monitor/protocol'

describe('toPerfMetric（§3.1 红线：value 一律 number）', () => {
  it('数值直接通过', () => {
    expect(toPerfMetric('fps', 60)).toEqual({ name: 'fps', value: 60 })
  })
  it('{value, score} 形态：value/score 提升到顶层，原对象进 detail', () => {
    const m = toPerfMetric('largest-contentful-paint', { value: 1234.56, score: 0.87 })
    expect(m).toMatchObject({ name: 'largest-contentful-paint', value: 1234.56, score: 0.87 })
    expect(m!.detail).toEqual({ value: 1234.56, score: 0.87 })
  })
  it('NavigationTiming 对象：主值取 pageLoad，整体进 detail', () => {
    const nt = { dnsLookup: 1, ttfb: 20, pageLoad: 2100.5 }
    const m = toPerfMetric('navigation-timing', nt)
    expect(m!.value).toBe(2100.5)
    expect(m!.detail).toEqual(nt)
  })
  it('RT 对象：主值取 slowTop 首条 duration', () => {
    const rt = { total: 10, slowTop: [{ url: 'a.js', duration: 800 }] }
    expect(toPerfMetric('resource-timing', rt)!.value).toBe(800)
  })
  it('INP 对象：主值取 duration，交互明细进 detail', () => {
    const inp = { duration: 88, eventName: 'click', targetCls: 'btn' }
    const m = toPerfMetric('interaction-to-next-paint', inp)
    expect(m!.value).toBe(88)
    expect(m!.detail).toEqual(inp)
  })
  it('无法提取数值主值的指标跳过（不造假数）', () => {
    expect(toPerfMetric('unknown-thing', { foo: 'bar' })).toBeNull()
    expect(toPerfMetric('x', 'not-a-number')).toBeNull()
    expect(toPerfMetric('x', NaN)).toBeNull()
  })
  it('score 钳制到 [0,1]（越界值会被服务端整信封拒收，§3.7 P1）', () => {
    expect(toPerfMetric('x', { value: 1, score: 5 })!.score).toBe(1)
    expect(toPerfMetric('x', { value: 1, score: -2 })!.score).toBe(0)
    expect(toPerfMetric('x', { value: 1, score: 0.87 })!.score).toBe(0.87)
  })
})

describe('toPerfEvent / toErrorEvent', () => {
  it('全部指标无法归一时返回 null（不产生空事件）', () => {
    expect(toPerfEvent({ a: 'x', b: { foo: 1 } })).toBeNull()
  })
  it('混合指标归一后组装 perf 事件，产出可被 protocol 校验的信封', () => {
    const event = toPerfEvent({
      fps: 60,
      'largest-contentful-paint': { value: 1234, score: 0.9 },
      'interaction-to-next-paint': { duration: 88, eventName: 'click' },
    })
    expect(event).not.toBeNull()
    const envelope = buildEnvelope(
      {
        apiKey: 'k',
        sdkName: 'test',
        sdkVersion: '0.0.1',
        sessionId: 's1',
        trackerId: 't1',
        page: 'http://x/',
      },
      [event!]
    )
    expect(validateEnvelope(envelope).success).toBe(true)
  })
  it('错误事件：堆栈/http 上下文/面包屑映射，产出可校验信封', () => {
    const event = toErrorEvent(
      {
        type: ErrorTypes.JAVASCRIPT_ERROR,
        message: 'boom',
        name: 'Error',
        level: 'Normal',
        time: 1759000000000,
        url: 'http://x.com/detail/123',
        errorId: 42,
        stack: [{ url: 'http://x.com/app.js', func: 'doThing', line: 10, column: 20 }],
        request: { method: 'GET', url: 'http://api.x.com/a', traceId: '00-ab' },
        response: { status: 500, data: 'oops' },
      } as any,
      [{ type: 'Click', data: '<button>提交</button>', time: 1 }]
    )
    expect(event.kind).toBe('error')
    expect(event.error.http?.status).toBe(500)
    expect(event.error.stackFrames?.[0].line).toBe(10)
    expect(event.breadcrumbs?.[0].type).toBe('Click')
    const envelope = buildEnvelope(
      {
        apiKey: 'k',
        sdkName: 'test',
        sdkVersion: '0.0.1',
        sessionId: 's1',
        trackerId: 't1',
        page: 'http://x.com/detail/123',
      },
      [event]
    )
    const result = validateEnvelope(envelope)
    expect(result.success).toBe(true)
  })
  it('隐私兜底：面包屑 data 序列化脱敏、凭证遮蔽、循环引用不炸（§3.7 P0-2）', () => {
    const event = toErrorEvent({ type: ErrorTypes.JAVASCRIPT_ERROR, message: 'boom' } as any, [
      { type: 'Route', data: { from: '/login?token=abc123', to: '/pay' }, time: 1 },
      { type: 'XHR', data: 'Bearer eyabcdefgh12', time: 2 },
      { type: 'Click', data: 'ok', time: 3 },
    ])
    const routeData = event.breadcrumbs?.[0].data as string
    expect(typeof routeData).toBe('string')
    expect(routeData).toContain('[credential]')
    expect(routeData).not.toContain('abc123')
    expect(event.breadcrumbs?.[1].data).toContain('[credential]')
    // 超长 data 截断到 LIMITS.breadcrumbData（512 + 截断提示后缀）
    const longEvent = toErrorEvent({ type: ErrorTypes.JAVASCRIPT_ERROR, message: 'x' } as any, [
      { type: 'Click', data: 'y'.repeat(2000), time: 1 },
    ])
    expect((longEvent.breadcrumbs?.[0].data as string).length).toBeLessThan(560)
    // 循环引用安全降级
    const circular: any = { self: null }
    circular.self = circular
    const circEvent = toErrorEvent({ type: ErrorTypes.JAVASCRIPT_ERROR, message: 'x' } as any, [
      { type: 'Click', data: circular, time: 1 },
    ])
    expect(circEvent.breadcrumbs?.[0].data).toBe('[unserializable]')
  })
  it('message 截断到 LIMITS.message（声明「SDK 发送端截断」落地）', () => {
    const event = toErrorEvent({
      type: ErrorTypes.JAVASCRIPT_ERROR,
      message: 'm'.repeat(5000),
    } as any)
    expect(event.error.message.length).toBeLessThan(1100)
    expect(event.error.message).toContain(`截取前${1024}个字符`)
  })
  it('信封出口脱敏（§3.8 P1）：message/帧 URL/http 文本中的凭证不外泄', () => {
    const event = toErrorEvent({
      type: ErrorTypes.JAVASCRIPT_ERROR,
      message: 'login failed: token=abc123',
      name: 'Bearer eyabcdefgh12',
      stack: [{ url: 'http://x.com/app.js?token=secret9', func: 'doThing', line: 1, column: 2 }],
      request: { method: 'POST', url: 'http://api.x.com/login', data: 'password=hunter2' },
      response: { status: 401, data: 'pwd=plain456' },
    } as any)
    expect(event.error.message).toContain('[credential]')
    expect(event.error.message).not.toContain('abc123')
    expect(event.error.name).toContain('[credential]')
    expect(event.error.stackFrames?.[0].url).toContain('[credential]')
    expect(event.error.stackFrames?.[0].url).not.toContain('secret9')
    expect(event.error.http?.reqData).toContain('[credential]')
    expect(event.error.http?.reqData).not.toContain('hunter2')
    expect(event.error.http?.responseText).not.toContain('plain456')
  })
})

describe('buildEnvelope', () => {
  it('auth/session/context 组装完整（release/env/device）', () => {
    const envelope = buildEnvelope(
      {
        apiKey: 'k1',
        release: 'v1.2.3',
        env: 'production',
        sdkName: '@simple-monitor/web',
        sdkVersion: '0.0.1',
        sessionId: 'sess-1',
        trackerId: 'track-1',
        page: 'http://x.com/',
        deviceInfo: { browser: 'chrome', browserVersion: '120', screen: '1920x1080' } as any,
      },
      [{ kind: 'perf', metrics: [{ name: 'fps', value: 60 }] }]
    )
    expect(envelope.protocolVersion).toBe(1)
    expect(envelope.auth).toMatchObject({ apiKey: 'k1', release: 'v1.2.3', env: 'production' })
    expect(envelope.session).toEqual({ sessionId: 'sess-1', trackerId: 'track-1' })
    expect(envelope.context.device).toEqual({
      browser: 'chrome',
      browserVersion: '120',
      screen: '1920x1080',
    })
    expect(validateEnvelope(envelope).success).toBe(true)
  })
})
