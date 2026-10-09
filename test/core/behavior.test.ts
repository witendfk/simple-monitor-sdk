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
