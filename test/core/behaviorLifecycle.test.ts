// @vitest-environment jsdom
/**
 * 行为通道离场生命周期回归（§3.3 P1）：
 *  - 缓冲的 PV/track/成功 API 在 hidden/pagehide 时各进 beacon 一次（不再等 5s 定时器）
 *  - hidden 多秒后 pagehide 不新增后台停留（dwell 只计可见期）
 *  - 恢复可见后继续发送，同段可见时长不重复结算
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { MonitorClient } from '@simple-monitor/core'
import { BehaviorTracker } from '../../packages/core/src/behavior'
import { setupReplace } from '../../packages/browser/src/setupReplace'

const beaconCalls: string[] = []

function makeTracker(): BehaviorTracker {
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
    getTrackSampleRate: () => 1,
    getApiSampleRate: () => 1,
  })
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

function dwellEventsOf(json: string): Array<{ activeMs: number }> {
  const env = JSON.parse(json)
  return env.events
    .filter(
      (e: { behavior?: { behaviorType?: string } }) => e.behavior?.behaviorType === 'page_dwell'
    )
    .map((e: { behavior: { activeMs: number } }) => e.behavior)
}

describe('行为通道离场生命周期（§3.3 P1）', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    beaconCalls.length = 0
  })

  it('core 生命周期：pagehide 排空缓冲；leaving 期事件即时出 beacon；恢复 active 后重新缓冲', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubGlobal('navigator', {
      sendBeacon: (url: string, data: string) => {
        void url
        if (typeof data === 'string') beaconCalls.push(data)
        return true
      },
    })
    const tracker = makeTracker()
    tracker.sendBehavior({ behaviorType: 'page_view', url: '/a' })
    tracker.sendBehavior({ behaviorType: 'page_view', url: '/b' })
    expect(tracker.pendingCount).toBe(2)

    window.dispatchEvent(new Event('pagehide'))
    expect(beaconCalls.length).toBe(1)
    expect(beaconCalls[0]).toContain('/a')
    expect(beaconCalls[0]).toContain('/b')
    expect(tracker.pendingCount).toBe(0)

    // leaving 期入队：单条即时出 beacon，不再缓冲
    tracker.sendBehavior({ behaviorType: 'page_view', url: '/c' })
    expect(beaconCalls.length).toBe(2)
    expect(beaconCalls[1]).toContain('/c')

    // 恢复活跃：重新缓冲（pageshow 与 visible 两条恢复路径都覆盖）
    window.dispatchEvent(new Event('pageshow'))
    tracker.sendBehavior({ behaviorType: 'page_view', url: '/d' })
    expect(tracker.pendingCount).toBe(1)
    expect(beaconCalls.length).toBe(2)
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    tracker.sendBehavior({ behaviorType: 'page_view', url: '/e' })
    expect(tracker.pendingCount).toBe(2)
    expect(beaconCalls.length).toBe(2)
    // 清空缓冲：防止本用例残留事件泄漏进同文件后续场景的 beacon 统计
    tracker.destroy()
  })

  it('场景：不足 5 秒关闭各类事件各进 beacon 一次；后台停留不计入；恢复可见不重复结算', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    vi.spyOn(Math, 'random').mockReturnValue(0) // 任何正采样率全放行
    vi.stubGlobal('navigator', {
      sendBeacon: (url: string, data: string) => {
        void url
        if (typeof data === 'string') beaconCalls.push(data)
        return true
      },
    })
    const client = new MonitorClient()
    client.init({
      dsn: 'http://localhost/report',
      apikey: 'k',
      trackSampleRate: 1,
      apiSampleRate: 1,
    })
    setupReplace(client) // PV 入缓冲，dwell 从此刻计时

    client.behavior.sendBehavior({ behaviorType: 'track', name: 't1', from: 'api' })
    client.behavior.sendApi({ method: 'GET', url: '/x', status: 200, durationMs: 5 })

    // 可见 3s 后 hidden：缓冲整体排空 + dwell 结算（3000ms 达阈）
    vi.setSystemTime(1_003_000)
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    const all = beaconCalls.join('\n')
    expect(all).toContain('page_view')
    expect(all).toContain('t1')
    expect(all).toContain('/x')
    expect(all.match(/page_dwell/g)).toHaveLength(1)
    const firstDwell = dwellEventsOf(beaconCalls.find((c) => c.includes('page_dwell'))!)
    expect(firstDwell[0].activeMs).toBe(3000)

    // hidden 5s 后 pagehide：不新增后台停留，无新 beacon
    const callsAtHidden = beaconCalls.length
    vi.setSystemTime(1_008_000)
    window.dispatchEvent(new Event('pagehide'))
    expect(beaconCalls.length).toBe(callsAtHidden)

    // 恢复可见 2s 后再次 hidden：继续发送，第二段 dwell 结算一次（不重复第一段）
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    vi.setSystemTime(1_010_000)
    client.behavior.sendBehavior({ behaviorType: 'track', name: 't2', from: 'api' })
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    const allDwells = beaconCalls.flatMap((c) => dwellEventsOf(c))
    expect(allDwells).toHaveLength(2)
    expect(allDwells[1].activeMs).toBe(2000)
    expect(beaconCalls.join('\n')).toContain('t2')
    expect(beaconCalls.join('\n').match(/page_view/g)).toHaveLength(1) // PV 不重复
  })
})
