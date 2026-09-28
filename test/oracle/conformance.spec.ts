/* eslint-disable @typescript-eslint/no-explicit-any -- playwright bridge 桥接无类型边界，测试 harness 场景豁免 */
/**
 * ADR-6 oracle 一致性测试（M3 旗舰项）
 *
 * 同一页面同时注入官方 `web-vitals` 与自研引擎（同一 PerformanceObserver 条目流），
 * 驱动 fixture 产生确定性的 LCP/CLS/INP，终值化后对比偏差：
 *   LCP ≤ 50ms、CLS ≤ 0.02、INP ≤ 100ms
 *
 * 「同页双跑」比「两次加载」更严格——条目流完全一致，偏差只来自算法本身。
 * 运行前提：chromium（npx playwright install chromium）+ 先 pnpm build（自研引擎取 dist）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { chromium, type Browser } from 'playwright'

const TOLERANCE = { lcp: 50, cls: 0.02, inp: 100 }
const ENGINE_DIST = resolve(__dirname, '../../packages/web-performance/dist/index.mjs')

let server: Server
let baseUrl: string
let browser: Browser

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0]
    try {
      const body =
        url === '/fixture.html'
          ? await readFile(resolve(__dirname, 'fixture.html'))
          : url === '/vendor/web-performance.mjs'
            ? await readFile(ENGINE_DIST)
            : null
      if (!body) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'content-type': url.endsWith('.mjs') ? 'text/javascript' : 'text/html; charset=utf-8',
      })
      res.end(body)
    } catch {
      res.writeHead(500).end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch()
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((r) => server.close(() => r()))
})

interface OracleValues {
  oracle: { lcp?: number; cls?: number; inp?: number }
  ours: { lcp?: number; cls?: number; inp?: number }
}

async function runDualInstrumentedPage(): Promise<OracleValues> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto(`${baseUrl}/fixture.html`)

  // 官方引擎（IIFE 全局 webVitals）
  await page.addScriptTag({
    path: resolve(__dirname, '../../node_modules/web-vitals/dist/web-vitals.iife.js'),
  })
  // 自研引擎（ESM dist）
  await page.addScriptTag({
    type: 'module',
    content: `
      import { WebVitals } from '/vendor/web-performance.mjs'
      window.__SimpleMonitorWebVitals = WebVitals
      window.__ready_consumer = (window.__ready_consumer ?? 0) + 1
      document.dispatchEvent(new Event('__consumer_ready__'))
    `,
  })
  // 两引擎都等 consumer 就绪后启动采集（必须在指标产生前注入）
  await page.waitForFunction(() => (window as any).__SimpleMonitorWebVitals, null, {
    timeout: 10_000,
  })
  await page.evaluate(() => {
    const w = window as any
    w.__oracle = {}
    w.__ours = {}
    // 官方：reportAllChanges 持续覆盖最新值
    w.webVitals.onLCP((m) => (w.__oracle.lcp = m.value), { reportAllChanges: true })
    w.webVitals.onCLS((m) => (w.__oracle.cls = m.value), { reportAllChanges: true })
    w.webVitals.onINP((m) => (w.__oracle.inp = m.value), { reportAllChanges: true })
    // 自研：immediately=true 逐指标回报；CLS/INP 终值在 synthetic hidden 时给出
    new w.__SimpleMonitorWebVitals({
      appId: 'oracle',
      immediately: true,
      reportCallback: (data: any) => {
        const metrics = data?.data
        if (!metrics) return
        const put = (name: string, value: number) => {
          if (typeof value === 'number' && Number.isFinite(value)) w.__ours[name] = value
        }
        if (metrics.name) {
          const v = metrics.value
          if (metrics.name === 'largest-contentful-paint') put('lcp', v)
          if (metrics.name === 'cumulative-layout-shift') put('cls', v)
          if (metrics.name === 'interaction-to-next-paint') put('inp', v?.duration)
        } else {
          for (const [k, m] of Object.entries(metrics as Record<string, any>)) {
            if (k === 'largest-contentful-paint') put('lcp', m?.value)
            if (k === 'cumulative-layout-shift') put('cls', m?.value)
            if (k === 'interaction-to-next-paint') put('inp', m?.value?.duration)
          }
        }
      },
    })
  })

  // 等 fixture 编排（hero2 @500ms、布局偏移 @800ms、busy 处理器 @900ms）
  await page.waitForFunction(
    () => (document.getElementById('log') as HTMLElement)?.textContent === 'ready-for-interaction',
    null,
    { timeout: 15_000 }
  )
  // 真实用户输入（trusted event）驱动 INP——程序化 click 的 interactionId=0，
  // 两个引擎（正确地）都不计入；真实点击同时按规范冻结 LCP
  await page.click('#btn')
  await page.waitForTimeout(150)
  await page.click('#btn')
  await page.waitForTimeout(400)

  // 受控合成 hidden：两引擎在此终值化 CLS/INP（onHidden 链）
  await page.evaluate(() => {
    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
    } catch (e) {
      /* 只读环境：pagehide 兜底 */
    }
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
  })
  await page.waitForTimeout(600)

  const values = await page.evaluate(() => ({
    oracle: (window as any).__oracle,
    ours: (window as any).__ours,
  }))
  await page.close()
  return values
}

describe('ADR-6 oracle 一致性（自研 web-vitals vs 官方库，同页双跑）', () => {
  it('LCP / CLS / INP 与官方引擎偏差在容差内', async () => {
    const { oracle, ours } = await runDualInstrumentedPage()
    expect(oracle.lcp, '官方 LCP 应产出').toBeTruthy()
    expect(oracle.cls, '官方 CLS 应产出').toBeTruthy()
    expect(oracle.inp, '官方 INP 应产出').toBeTruthy()

    expect(ours.lcp, '自研 LCP 应产出').toBeTruthy()
    expect(ours.cls, '自研 CLS 应产出').toBeTruthy()
    expect(ours.inp, '自研 INP 应产出').toBeTruthy()

    expect(Math.abs(ours.lcp! - oracle.lcp!), `LCP 偏差 ≤ ${TOLERANCE.lcp}ms`).toBeLessThanOrEqual(
      TOLERANCE.lcp
    )
    expect(Math.abs(ours.cls! - oracle.cls!), `CLS 偏差 ≤ ${TOLERANCE.cls}`).toBeLessThanOrEqual(
      TOLERANCE.cls
    )
    expect(Math.abs(ours.inp! - oracle.inp!), `INP 偏差 ≤ ${TOLERANCE.inp}ms`).toBeLessThanOrEqual(
      TOLERANCE.inp
    )
  }, 30_000)
})
