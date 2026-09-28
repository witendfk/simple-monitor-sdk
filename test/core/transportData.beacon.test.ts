import { describe, it, expect, vi, afterEach } from 'vitest'
import { transportData } from '@simple-monitor/core'

describe('beaconPost (sendBeacon 通道)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sendBeacon 可用且返回 true → 走 beacon，不走 xhr', () => {
    const beacon = vi.fn(() => true)
    vi.stubGlobal('navigator', { sendBeacon: beacon })
    const xhrSpy = vi.spyOn(transportData, 'xhrPost').mockImplementation(() => undefined)

    transportData.beaconPost({ authInfo: {} } as any, 'http://x/report')

    expect(beacon).toHaveBeenCalledWith('http://x/report', expect.any(String))
    expect(xhrSpy).not.toHaveBeenCalled()
  })

  it('sendBeacon 返回 false → 降级 xhrPost', () => {
    const beacon = vi.fn(() => false)
    vi.stubGlobal('navigator', { sendBeacon: beacon })
    const xhrSpy = vi.spyOn(transportData, 'xhrPost').mockImplementation(() => undefined)

    transportData.beaconPost({ authInfo: {} } as any, 'http://x/report')

    expect(xhrSpy).toHaveBeenCalled()
  })

  it('sendBeacon 不可用 → 降级 xhrPost', () => {
    vi.stubGlobal('navigator', {})
    const xhrSpy = vi.spyOn(transportData, 'xhrPost').mockImplementation(() => undefined)

    transportData.beaconPost({ authInfo: {} } as any, 'http://x/report')

    expect(xhrSpy).toHaveBeenCalled()
  })
})
