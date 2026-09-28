import { describe, it, expect, vi, afterEach } from 'vitest'
import { transportData } from '@simple-monitor/core'
import { options } from '@simple-monitor/core'

describe('disabled 配置', () => {
  afterEach(() => {
    options.disabled = false
    vi.restoreAllMocks()
  })

  it('disabled=true 时 send 在最前面拦截，不触达任何上报通道', async () => {
    options.disabled = true
    // 即便 dsn 已配置，disabled 也应在 dsn 判断之前拦截
    transportData.bindOptions({ dsn: 'http://localhost/report', apikey: 'k' })

    const xhrSpy = vi.spyOn(transportData, 'xhrPost').mockImplementation(() => undefined)
    const imgSpy = vi.spyOn(transportData, 'imgRequest').mockImplementation(() => undefined)

    await transportData.send({ type: 'LOG_ERROR', url: 'x', level: 'Low', message: 'm' } as any)

    expect(xhrSpy).not.toHaveBeenCalled()
    expect(imgSpy).not.toHaveBeenCalled()
  })

  it('disabled 默认 false', () => {
    expect(options.disabled).toBe(false)
  })
})
