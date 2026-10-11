/**
 * 行为域追踪器测试（M7 ADR-8）：按域采样 / 防风暴上限 / props 截断 / 采样放行语义
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { BehaviorTracker, sanitizeTrackPayload } from '../../packages/core/src/behavior'

function makeTracker(opts: { trackRate?: number; apiRate?: number } = {}): BehaviorTracker {
  return new BehaviorTracker({
    getDsn: () => 'http://localhost/report',
    getContext: () => ({
      apiKey: 'k',
      release: 'v0.1.0',
      sdkName: 'test',
      sdkVersion: '0.0.1',
      sessionId: 's',
      trackerId: 't',
      page: '/orders',
      viewId: '/orders',
    }),
    getTrackSampleRate: () => opts.trackRate ?? 1,
    getApiSampleRate: () => opts.apiRate ?? 1,
  })
}

describe('BehaviorTracker 采样与入队', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('采样率 1：behavior 全部入队（独立信封组，pendingCount 递增）', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // 任何正采样率都放行
    const tracker = makeTracker({ trackRate: 1 })
    tracker.sendBehavior({ behaviorType: 'page_view', url: '/a' })
    tracker.sendBehavior({ behaviorType: 'page_view', url: '/b' })
    expect(tracker.pendingCount).toBe(2)
  })

  it('采样率 0：behavior 全部丢弃（按域采样，错误主通道不受影响）', () => {
    const tracker = makeTracker({ trackRate: 0 })
    tracker.sendBehavior({ behaviorType: 'page_view', url: '/a' })
    expect(tracker.pendingCount).toBe(0)
  })

  it('api 明细独立采样（apiRate=0 时丢弃）', () => {
    const tracker = makeTracker({ apiRate: 0 })
    tracker.sendApi({ method: 'GET', url: '/x', status: 200, durationMs: 12 })
    expect(tracker.pendingCount).toBe(0)
  })

  it('单会话防风暴：超过 LIMITS.maxBehaviorPerSession 静默丢弃', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const tracker = makeTracker()
    for (let i = 0; i < 505; i++) {
      tracker.sendBehavior({ behaviorType: 'track', name: `n${i}`, from: 'api' })
    }
    // 满 10 条触发 flush、上限 500 条硬顶：入队总量不会无限增长
    expect(tracker.pendingCount).toBeLessThanOrEqual(500)
  })
})

describe('sanitizeTrackPayload（props 截断）', () => {
  it('name 超 128 字符截断', () => {
    const r = sanitizeTrackPayload('n'.repeat(200), { a: 1 })
    expect(r.name.length).toBe(128)
  })

  it('props 键数超 32 截断到前 32 键（保留 name 与部分数据）', () => {
    const props = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))
    const r = sanitizeTrackPayload('ok', props)
    expect(r.name).toBe('ok')
    expect(Object.keys(r.props ?? {})).toHaveLength(32)
  })
})

describe('行为预算与声明式 LIMITS（§3.3 P2）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('成功 API 不占行为预算：预算满额后 API 仍入队出站，第 501 条行为被预算丢弃', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('fetch', () => new Promise(() => {})) // 冻结主动期发送：事件留在缓冲便于观测
    const beacon = vi.fn(() => true)
    vi.stubGlobal('navigator', { sendBeacon: beacon })
    const tracker = makeTracker()
    for (let i = 0; i < 500; i++) {
      tracker.sendBehavior({ behaviorType: 'track', name: `n${i}`, from: 'api' })
    }
    expect(tracker.behaviorBudgetUsed).toBe(500)
    tracker.sendApi({ method: 'GET', url: '/budget-check', status: 200, durationMs: 1 })
    tracker.markLeaving()
    const events = JSON.parse(beacon.mock.calls[0][1]).events
    // API 事件进入信封（不受行为预算限制）；第 501 条行为被预算丢弃
    expect(
      events.some((e: { kind: string; api?: { url: string } }) => e.api?.url === '/budget-check')
    ).toBe(true)
    // leaving 期再试一条行为：预算已满，不产生新信封
    tracker.sendBehavior({ behaviorType: 'track', name: 'over', from: 'api' })
    expect(beacon).toHaveBeenCalledTimes(1)
    expect(tracker.behaviorBudgetUsed).toBe(500)
  })

  it('声明式入口 LIMITS 对齐：props 超 32 键截断、序列化超 2KB 丢 props（事件本体不拒收）', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const beacon = vi.fn(() => true)
    vi.stubGlobal('navigator', { sendBeacon: beacon })
    const tracker = makeTracker()
    tracker.sendBehavior({
      behaviorType: 'track',
      name: 'decl',
      props: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'v'])),
      from: 'declarative',
    })
    tracker.sendBehavior({
      behaviorType: 'track',
      name: 'big',
      props: { blob: 'x'.repeat(3000) },
      from: 'declarative',
    })
    tracker.markLeaving()
    expect(beacon).toHaveBeenCalledTimes(1) // 两事件同信封发出，均未被整包拒绝
    const env = JSON.parse(beacon.mock.calls[0][1])
    const behaviors = env.events.map((e: { behavior: { name: string } }) => e.behavior)
    expect(behaviors[0].name).toBe('decl')
    expect(Object.keys(behaviors[0].props)).toHaveLength(32)
    expect(behaviors[1].name).toBe('big') // 事件本体保留
    expect(behaviors[1].props).toBeUndefined() // 超 2KB 序列化：丢 props
  })
})
