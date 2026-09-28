// @vitest-environment jsdom
/**
 * web 门面（facade）测试（M1）——独立文件：门面走默认 client + 全局 INIT_FLAG，
 * 需要干净的模块状态（与 browser 采集层测试文件隔离）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetDefaultMonitorClient } from '@simple-monitor/core'
import { init as initWeb } from '../../packages/web/src/index'

describe('web 门面（facade）', () => {
  beforeEach(() => {
    resetDefaultMonitorClient()
    delete (globalThis as any).__Monitor__init__
    vi.restoreAllMocks()
  })

  it('init 失败（缺 apikey）返回 false，不置全局标记、不启动性能采集', () => {
    expect(initWeb({ dsn: 'http://x' } as any)).toBe(false)
    expect((globalThis as any).__Monitor__init__).toBeUndefined()
  })

  it('init 成功置全局标记；重复 init 幂等返回 true', () => {
    const ok = initWeb({ dsn: 'http://localhost/report', apikey: 'k' })
    expect(ok).toBe(true)
    expect((globalThis as any).__Monitor__init__).toBe(true)
    expect(initWeb({ dsn: 'http://localhost/report', apikey: 'k' })).toBe(true)
  })

  it('performance:false 关闭性能采集', () => {
    // 仅验证不抛错且成功（性能引擎构造的断言在 web-performance 包测试中）
    expect(initWeb({ dsn: 'http://localhost/report', apikey: 'k', performance: false })).toBe(true)
  })
})
