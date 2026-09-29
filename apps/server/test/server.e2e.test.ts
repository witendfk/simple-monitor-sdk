/**
 * 服务端 e2e（内存实现全链路）：接入校验/鉴权/限流 → 队列 → 归一化落库 → 查询 API
 * 全部使用内存实现（零外部依赖）；基础设施实现由 docker-compose 交付。
 */
import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Server } from 'http'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { PROTOCOL_VERSION, type TransportEnvelope } from '@simple-monitor/protocol'
import { AppModule, CONFIG_TOKEN } from '../src/app.module'
import { IngestService } from '../src/ingest/ingest.service'

interface ErrorGroupSummary {
  fingerprint: string
  type: string
  message: string
  count: number
}
import { ProjectsService } from '../src/projects/projects.service'
import type { ServerConfig } from '../src/config'

const envelopeFixture = (): TransportEnvelope => ({
  protocolVersion: PROTOCOL_VERSION,
  sentAt: Date.now(),
  auth: { apiKey: 'test-key', release: 'v1.0.0', sdk: { name: 'web', version: '0.0.1' } },
  session: { sessionId: 'sess-1', trackerId: 'track-1' },
  context: { page: 'http://x.com/checkout' },
  events: [
    {
      kind: 'error',
      error: {
        type: 'JAVASCRIPT_ERROR',
        message: 'boom at checkout',
        name: 'TypeError',
        viewId: '/checkout/{param}',
        stackFrames: [{ url: 'http://x.com/app.js', func: 'submit', line: 42, column: 7 }],
      },
      breadcrumbs: [{ type: 'Click', data: '<button>提交</button>' }],
    },
    { kind: 'perf', metrics: [{ name: 'largest-contentful-paint', value: 2100 }] },
  ],
})

describe('server e2e（内存全链路）', () => {
  let app: INestApplication
  let server: Server

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONFIG_TOKEN)
      .useValue({
        port: 0,
        projectsJson: JSON.stringify([{ apikey: 'test-key', name: 'test', rateLimitPerMin: 3 }]),
      } satisfies ServerConfig)
      .overrideProvider(ProjectsService)
      .useFactory({
        factory: () =>
          ProjectsService.fromJson(
            JSON.stringify([{ apikey: 'test-key', name: 'test', rateLimitPerMin: 3 }])
          ),
      })
      .compile()
    app = moduleRef.createNestApplication()
    app.use(expressJsonForTest())
    await app.init()
    // main.ts bootstrap 同款：启动消费循环（内存队列 50ms 泵）
    app.get(IngestService).start()
    server = app.getHttpServer()
  }, 30_000)

  afterAll(async () => {
    await app.close()
  })

  it('合法信封 → 204，异步消费后查询 API 可见（含服务端指纹分组）', async () => {
    const res = await request(server).post('/report/batch').send(envelopeFixture())
    expect(res.status).toBe(204)

    // 队列 50ms 泵间隔 + 归一化落库，轮询等待
    let groups: ErrorGroupSummary[] = []
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const overview = await request(server).get('/api/overview?sinceMinutes=60')
      if (overview.body.errorCount > 0) {
        const list = await request(server).get('/api/errors?limit=10')
        groups = list.body
        break
      }
    }
    expect(groups.length).toBeGreaterThan(0)
    expect(groups[0].type).toBe('JAVASCRIPT_ERROR')
    expect(groups[0].message).toBe('boom at checkout')
    expect(groups[0].fingerprint).toBeTruthy()

    // 详情 API：指纹取回样本（含堆栈）
    const detail = await request(server).get(`/api/errors/${groups[0].fingerprint}`)
    expect(detail.status).toBe(200)
    expect(detail.body.error?.stackFrames?.[0].line).toBe(42)

    // 性能分位
    const perf = await request(server).get(
      '/api/performance?metric=largest-contentful-paint&sinceMinutes=60'
    )
    expect(perf.body.count).toBe(1)
    expect(perf.body.p75).toBe(2100)
  })

  it('非法信封 → 400 带校验问题清单', async () => {
    const res = await request(server)
      .post('/report/batch')
      .send({ protocolVersion: 99, garbage: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid envelope')
    expect(Array.isArray(res.body.issues)).toBe(true)
  })

  it('未注册 apikey → 403', async () => {
    const env = envelopeFixture()
    env.auth.apiKey = 'not-registered'
    const res = await request(server).post('/report/batch').send(env)
    expect(res.status).toBe(403)
  })

  it('限流：超过 rateLimitPerMin（=3）→ 429 + Retry-After', async () => {
    // test-key 已在上一用例消耗配额；连发直到被限流
    let hit429 = false
    let lastStatus = 0
    for (let i = 0; i < 6; i++) {
      const res = await request(server).post('/report/batch').send(envelopeFixture())
      lastStatus = res.status
      if (res.status === 429) {
        hit429 = true
        expect(res.headers['retry-after']).toBeDefined()
        expect(res.body.error).toBe('rate limited')
        break
      }
    }
    expect(hit429, `期望触发限流（最后状态码 ${lastStatus}）`).toBe(true)
  })
})

/** supertest 场景的 body 解析（与 main.ts 同款：一切 Content-Type 按 JSON 解析） */
import express from 'express'
function expressJsonForTest(): express.RequestHandler {
  return express.json({ type: () => true, limit: '256kb' })
}
