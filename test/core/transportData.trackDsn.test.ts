import { describe, it, expect, vi, afterEach } from 'vitest'
import { transportData } from '../../packages/core/src/transportData'
import { logger } from '@simple-monitor/utils'

/**
 * M0 红线回归（总纲 §3.1）：trackDsn 未配置时回落 dsn。
 * 旧行为：README 快速开始只传 dsn+apikey → 性能数据走 trackDsn 为空 → 静默丢弃。
 */
describe('trackDsn 缺省回落 dsn', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('未配置 trackDsn 时回落 dsn', () => {
    transportData.bindOptions({ dsn: 'http://localhost/report', apikey: 'k' })
    expect(transportData.errorDsn).toBe('http://localhost/report')
    expect(transportData.trackDsn).toBe('http://localhost/report')
  })

  it('显式配置 trackDsn 优先生效（独立埋点通道仍可用）', () => {
    transportData.bindOptions({
      dsn: 'http://a/report',
      trackDsn: 'http://b/track',
      apikey: 'k',
    })
    expect(transportData.trackDsn).toBe('http://b/track')
  })

  it('显式空串 trackDsn 视为未配置，同样回落', () => {
    transportData.bindOptions({ dsn: 'http://c/report', trackDsn: '', apikey: 'k' })
    expect(transportData.trackDsn).toBe('http://c/report')
  })

  it('性能数据在只有 dsn 的配置下不再触发"trackDsn为空"丢弃错误', async () => {
    transportData.bindOptions({ dsn: 'http://localhost/report', apikey: 'k' })
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    await transportData.send({ eventType: 'performance', metrics: { fps: 60 } } as any)
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('trackDsn为空'),
      expect.anything()
    )
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('trackDsn为空'))
  })
})
