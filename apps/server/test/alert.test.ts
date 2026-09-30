/**
 * 告警域测试（M6）：判定纯函数 / 引擎评估与冷却 / webhook 投递 / 规则 API
 */
import 'reflect-metadata'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import type { Server } from 'http'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { isSpike, isThresholdBreached } from '../src/alert/alert.types'
import { AlertEngine, type WebhookSender } from '../src/alert/alert-engine'
import { AlertRuleStore } from '../src/alert/rule-store'
import type { IEventStorage, OverviewStats } from '../src/storage/event-storage'

describe('判定纯函数', () => {
  it('突增：高流量按倍数，低流量按 minCount 兜底', () => {
    const cfg = { windowMinutes: 15, baselineMinutes: 360, minCount: 20, multiplier: 3 }
    expect(isSpike({ recentErrorCount: 31, baselineAvgPerWindow: 10 }, cfg)).toBe(true)
    expect(isSpike({ recentErrorCount: 30, baselineAvgPerWindow: 10 }, cfg)).toBe(false) // 恰在阈值不算
    // 基线均值 0：minCount 兜底生效（20 条以上才算突增）
    expect(isSpike({ recentErrorCount: 15, baselineAvgPerWindow: 0 }, cfg)).toBe(false)
    expect(isSpike({ recentErrorCount: 21, baselineAvgPerWindow: 0 }, cfg)).toBe(true)
  })

  it('阈值：P75 为 null（无样本）不触发', () => {
    expect(isThresholdBreached(4000, { metric: 'lcp', threshold: 4000, windowMinutes: 60 })).toBe(
      true
    )
    expect(isThresholdBreached(3999, { metric: 'lcp', threshold: 4000, windowMinutes: 60 })).toBe(
      false
    )
    expect(isThresholdBreached(null, { metric: 'lcp', threshold: 4000, windowMinutes: 60 })).toBe(
      false
    )
  })
})

/** 存储桩：overview 返回预设错误数（签名随 IEventStorage：首参 apikey，桩忽略） */
function stubStorage(errorCount: number): IEventStorage {
  const overview = (): OverviewStats => ({
    since: '',
    until: '',
    totalEvents: errorCount,
    errorCount,
    perfCount: 0,
    sessionCount: 1,
    topErrors: [],
  })
  return {
    saveBatch: async () => undefined,
    overview: async (): Promise<OverviewStats> => overview(),
    errorGroups: async () => [],
    errorDetail: async () => null,
    performanceQuantiles: async () => ({ metric: 'x', count: 1, p50: 100, p75: 100, p95: 100 }),
  }
}

describe('AlertEngine', () => {
  const sender = { send: vi.fn().mockResolvedValue(undefined) }

  beforeEach(() => {
    sender.send.mockClear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeEngine(
    storage: IEventStorage,
    webhook: WebhookSender = sender,
    intervalMs = 5 * 60_000
  ): { engine: AlertEngine; store: AlertRuleStore } {
    const store = new AlertRuleStore()
    const engine = new AlertEngine(storage, store, webhook, intervalMs)
    engine.start()
    return { engine, store }
  }

  it('突增规则触发：投递 webhook 载荷含结构化上下文并进入冷却记录', async () => {
    const storage = stubStorage(50) // 近 15min 50 条，基线均值 10 → 阈值 30 → 触发
    const { engine, store } = makeEngine(
      {
        ...storage,
        // 签名 (apikey, sinceMs)：按规则归属项目查询（apikey 隔离）
        overview: async (_apikey: string, sinceMs: number): Promise<OverviewStats> => ({
          since: '',
          until: '',
          totalEvents: 50,
          // 基线 6h 40 条 → 每窗口(15min)均值 ≈ 10；阈值 max(20, 30) = 30 → 50 触发
          errorCount: sinceMs === 15 * 60_000 ? 50 : 40,
          perfCount: 0,
          sessionCount: 1,
          topErrors: [],
        }),
      },
      sender
    )
    store.create({
      apikey: 'k',
      type: 'error_spike',
      name: '错误突增',
      webhookUrl: 'https://hooks.example.com/x',
      cooldownMinutes: 15,
      enabled: true,
      config: { windowMinutes: 15, baselineMinutes: 360, minCount: 20, multiplier: 3 },
    })

    const fires = await engine.evaluateAll()
    expect(fires).toHaveLength(1)
    expect(sender.send).toHaveBeenCalledTimes(1)
    const [url, payload] = sender.send.mock.calls[0]
    expect(url).toBe('https://hooks.example.com/x')
    const content = (payload as { content?: { text?: string } }).content
    expect(content?.text).toContain('错误突增')
    expect(store.listFires()).toHaveLength(1)
  })

  it('冷却窗口内不重复投递（防轰炸）', async () => {
    const storage = stubStorage(50)
    const { engine, store } = makeEngine(storage, sender)
    store.create({
      apikey: 'k',
      type: 'error_spike',
      name: 'r',
      webhookUrl: 'https://hooks.example.com/x',
      cooldownMinutes: 15,
      enabled: true,
      config: { windowMinutes: 15, baselineMinutes: 360, minCount: 20, multiplier: 3 },
    })

    const now = Date.now()
    await engine.evaluateAll(now)
    await engine.evaluateAll(now + 60_000) // 1 分钟后：仍在冷却
    expect(sender.send).toHaveBeenCalledTimes(1)

    await engine.evaluateAll(now + 16 * 60_000) // 冷却过后：再次投递
    expect(sender.send).toHaveBeenCalledTimes(2)
  })

  it('webhook 投递失败：不进入冷却（下轮重试），不抛出', async () => {
    const failingSender = { send: vi.fn().mockRejectedValue(new Error('hook down')) }
    const { engine, store } = makeEngine(stubStorage(50), failingSender)
    store.create({
      apikey: 'k',
      type: 'error_spike',
      name: 'r',
      webhookUrl: 'https://hooks.example.com/x',
      cooldownMinutes: 15,
      enabled: true,
      config: { windowMinutes: 15, baselineMinutes: 360, minCount: 20, multiplier: 3 },
    })
    await expect(engine.evaluateAll()).resolves.toHaveLength(0)
    expect(store.listFires()).toHaveLength(0) // 投递失败不记触发
  })

  it('阈值规则：P75 超阈触发', async () => {
    const storage = stubStorage(0)
    const q = vi
      .fn()
      .mockResolvedValue({ metric: 'lcp', count: 5, p50: 1000, p75: 5000, p95: 8000 })
    const { engine } = makeEngine({ ...storage, performanceQuantiles: q }, sender)
    const store = (engine as unknown as { store: AlertRuleStore }).store
    store.create({
      apikey: 'k',
      type: 'perf_threshold',
      name: 'LCP 超阈',
      webhookUrl: 'https://hooks.example.com/lcp',
      cooldownMinutes: 30,
      enabled: true,
      config: { metric: 'lcp', threshold: 4000, windowMinutes: 60 },
    })
    const fires = await engine.evaluateAll()
    expect(fires).toHaveLength(1)
    expect(fires[0].message).toContain('P75 超阈')
    expect(sender.send).toHaveBeenCalledTimes(1)
  })

  it('enabled=false 的规则被跳过', async () => {
    const { engine, store } = makeEngine(stubStorage(50), sender)
    store.create({
      apikey: 'k',
      type: 'error_spike',
      name: 'disabled',
      webhookUrl: 'https://hooks.example.com/x',
      cooldownMinutes: 15,
      enabled: false,
      config: { windowMinutes: 15, baselineMinutes: 360, minCount: 20, multiplier: 3 },
    })
    const fires = await engine.evaluateAll()
    expect(fires).toHaveLength(0)
    expect(sender.send).not.toHaveBeenCalled()
  })
})

describe('告警规则 API', () => {
  let app: INestApplication
  let server: Server

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [await import('../src/app.module').then((m) => m.AppModule)],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    server = app.getHttpServer()
  }, 30_000)

  afterAll(async () => {
    await app.close()
  })

  it('创建 → 列表 → 删除 → 404', async () => {
    const created = await request(server)
      .post('/api/alert-rules')
      .set('x-api-key', 'demo-key')
      .send({
        type: 'error_spike',
        name: 'e2e 规则',
        webhookUrl: 'https://hooks.example.com/e2e',
        cooldownMinutes: 10,
        enabled: true,
        config: { windowMinutes: 15, baselineMinutes: 360, minCount: 20, multiplier: 3 },
      })
    expect(created.status).toBe(201)
    const id = created.body.id as string

    const list = await request(server).get('/api/alert-rules').set('x-api-key', 'demo-key')
    expect(list.body.some((r: { id: string }) => r.id === id)).toBe(true)

    const del = await request(server).delete(`/api/alert-rules/${id}`).set('x-api-key', 'demo-key')
    expect(del.status).toBe(200)
    const gone = await request(server).delete(`/api/alert-rules/${id}`).set('x-api-key', 'demo-key')
    expect(gone.status).toBe(404)
  })

  it('无鉴权头 / 未注册 apikey → 401（规则 CRUD 不再匿名可用）', async () => {
    const noHeader = await request(server).get('/api/alert-rules')
    expect(noHeader.status).toBe(401)
    const ghost = await request(server).get('/api/alert-rules').set('x-api-key', 'ghost')
    expect(ghost.status).toBe(401)
  })

  it('非法 webhookUrl 被拒（协议白名单 + 非 URL 即 400）', async () => {
    const res = await request(server)
      .post('/api/alert-rules')
      .set('x-api-key', 'demo-key')
      .send({
        type: 'perf_threshold',
        name: 'bad',
        webhookUrl: 'not-a-url',
        config: { metric: 'lcp', threshold: 4000 },
      })
    expect(res.status).toBe(400)
  })

  it('私网/元数据 webhookUrl 被 SSRF 防护拒绝', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:6379/',
      'http://127.0.0.1:8080/hook',
      'file:///etc/passwd',
    ]) {
      const res = await request(server)
        .post('/api/alert-rules')
        .set('x-api-key', 'demo-key')
        .send({
          type: 'perf_threshold',
          name: 'ssrf',
          webhookUrl: url,
          config: { metric: 'lcp', threshold: 4000 },
        })
      expect(res.status, `webhookUrl ${url} 应被拒`).toBe(400)
    }
  })

  it('触发记录接口可查询', async () => {
    const res = await request(server).get('/api/alert-fires?limit=10').set('x-api-key', 'demo-key')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })
})
