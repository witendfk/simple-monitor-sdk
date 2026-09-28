// @vitest-environment jsdom
/**
 * 回归测试（CI 0/1 事故修复）：
 * M1 的 facade 测试在 jsdom 下真实构造 WebVitals，document.readyState === 'complete'
 * 时 afterLoad 走 setTimeout 分支 → initNavigationTiming 在 node/jsdom 的
 * performance（无 navigation 条目、performance.timing 为 undefined）里同步解构崩溃
 * → unhandled rejection → vitest exit 1（本地 node 18 时序走了 pageshow 分支未暴露）。
 *
 * 本文件强制走 setTimeout 分支复现 CI 路径：任何未捕获异常都会让 vitest 判红。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import MetricsStore from '../../packages/web-performance/src/lib/store'
import { initNavigationTiming } from '../../packages/web-performance/src/metrics/getNavigationTiming'

describe('navigationTiming 环境防御（CI 回归）', () => {
  const originalReadyState = Object.getOwnPropertyDescriptor(Document.prototype, 'readyState')

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalReadyState) {
      Object.defineProperty(Document.prototype, 'readyState', originalReadyState)
    }
  })

  it('无 navigation 条目时 initNavigationTiming 静默跳过（不崩溃、不造假数据）', async () => {
    const store = new MetricsStore()
    const report = vi.fn()
    expect(() => initNavigationTiming(store, report, true)).not.toThrow()
    // 等 Promise 链排空——若存在 unhandled rejection，vitest 会直接判红
    await new Promise((r) => setTimeout(r, 10))
    expect(store.has('navigation-timing')).toBe(false)
    expect(report).not.toHaveBeenCalled()
  })

  it('WebVitals 完整构造（readyState=complete 强制 setTimeout 分支）无 unhandled 异常', async () => {
    // 强制 afterLoad 走 setTimeout 分支（CI 失败路径）
    Object.defineProperty(document, 'readyState', {
      configurable: true,
      get: () => 'complete',
    })
    const { WebVitals } = await import('../../packages/web-performance/src/index')
    expect(
      () =>
        new WebVitals({
          appId: 'regression',
          immediately: false,
          reportCallback: () => undefined,
        })
    ).not.toThrow()
    // 排空 afterLoad 定时器链：崩溃会以 unhandled rejection 形式让本文件判红
    await new Promise((r) => setTimeout(r, 20))
  })
})
