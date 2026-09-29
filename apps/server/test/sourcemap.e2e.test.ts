/**
 * SourceMap 符号化 e2e（M5 旗舰链路）：
 * esbuild 真实产出 map → CLI 同款请求上传 → 上报压缩堆栈 →
 * 详情 API 返回原始源码位置（玩具与产品的分水岭功能闭环）。
 */
import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Server } from 'http'
import { Test } from '@nestjs/testing'
import { transformSync } from 'esbuild'
import { PROTOCOL_VERSION, type TransportEnvelope } from '@simple-monitor/protocol'
import { AppModule, CONFIG_TOKEN } from '../src/app.module'
import { IngestService } from '../src/ingest/ingest.service'
import type { ServerConfig } from '../src/config'

const ORIGINAL_SOURCE = `export function checkoutSubmit(total: number): number {
  const checkoutTotal = total * 100
  if (checkoutTotal < 0) {
    throw new Error('invalid total')
  }
  return checkoutTotal
}
`

describe('SourceMap 符号化全链路', () => {
  let app: import('@nestjs/common').INestApplication
  let server: Server
  let generatedJs: string
  let generatedMap: string

  beforeAll(async () => {
    // 1. esbuild 真实压缩 + 产出 source map（不用手写 VLQ）
    const out = transformSync(ORIGINAL_SOURCE, {
      loader: 'ts',
      minify: true,
      sourcemap: true,
      sourcefile: 'src/checkout.ts',
    })
    generatedJs = out.code
    generatedMap = out.map

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONFIG_TOKEN)
      .useValue({
        port: 0,
        projectsJson: JSON.stringify([{ apikey: 'k', name: 't', rateLimitPerMin: 1000 }]),
      } satisfies ServerConfig)
      .compile()
    app = moduleRef.createNestApplication()
    app.use(expressJsonForTest())
    await app.init()
    app.get(IngestService).start()
    server = app.getHttpServer()
  }, 30_000)

  afterAll(async () => {
    await app.close()
  })

  async function postJson(path: string, body: unknown): Promise<request.Response> {
    return request(server)
      .post(path)
      .send(body as object)
  }

  it('上传 map → 上报压缩堆栈 → 详情返回原始源码位置', async () => {
    // 2. 上传工件（CLI 同款请求形状）
    const upload = await postJson('/api/sourcemaps', {
      apikey: 'k',
      release: 'v1.2.3',
      url: 'app.js',
      map: generatedMap,
    })
    expect(upload.status).toBe(201)

    // 3. 在压缩产物里定位一个真实位置：字符串字面量不会被 minify 重命名
    //（局部变量 checkoutTotal 会被改名，不能用——见上一轮教训）
    const idx = generatedJs.indexOf('invalid total')
    expect(idx).toBeGreaterThan(0)
    const before = generatedJs.slice(0, idx)
    const line = before.split('\n').length
    const column = idx - (before.lastIndexOf('\n') + 1) + 1

    // 4. 上报压缩堆栈错误（SDK 实际发出的形状）
    const envelope: TransportEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      sentAt: Date.now(),
      auth: { apiKey: 'k', release: 'v1.2.3', sdk: { name: 'web', version: '0.0.1' } },
      session: { sessionId: 's9', trackerId: 't9' },
      context: { page: 'http://x.com/checkout' },
      events: [
        {
          kind: 'error',
          error: {
            type: 'JAVASCRIPT_ERROR',
            message: 'invalid total',
            stackFrames: [{ url: 'app.js', func: 'submit', line, column }],
          },
        },
      ],
    }
    const report = await postJson('/report/batch', envelope)
    expect(report.status).toBe(204)

    // 等消费泵
    let groups: Array<{ fingerprint: string }> = []
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const list = await request(server).get('/api/errors?limit=10')
      if (list.body.length > 0) {
        groups = list.body
        break
      }
    }
    expect(groups.length).toBeGreaterThan(0)

    // 5. 详情：symbolicatedStack 含原始源码位置
    const detail = await request(server).get(`/api/errors/${groups[0].fingerprint}`)
    expect(detail.status).toBe(200)
    const symbolicated = detail.body.symbolicatedStack?.[0]
    expect(symbolicated?.original).toBeTruthy()
    expect(symbolicated.original.source).toBe('src/checkout.ts')
    expect(symbolicated.original.line).toBeGreaterThan(0)
  })

  it('未匹配工件/无 release 的帧：original=null 透传（不阻断）', async () => {
    const envelope: TransportEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      sentAt: Date.now(),
      auth: { apiKey: 'k', sdk: { name: 'web', version: '0.0.1' } },
      session: { sessionId: 's10', trackerId: 't10' },
      context: { page: 'http://x.com/' },
      events: [
        {
          kind: 'error',
          error: {
            type: 'JAVASCRIPT_ERROR',
            message: 'no release no map',
            stackFrames: [{ url: 'unknown.js', func: 'f', line: 1, column: 1 }],
          },
        },
      ],
    }
    await postJson('/report/batch', envelope)
    let fingerprint = ''
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const list = await request(server).get('/api/errors?limit=50')
      const group = (list.body as Array<{ message: string; fingerprint: string }>).find(
        (g) => g.message === 'no release no map'
      )
      if (group) {
        fingerprint = group.fingerprint
        break
      }
    }
    expect(fingerprint).toBeTruthy()
    const detail = await request(server).get(`/api/errors/${fingerprint}`)
    expect(detail.body.symbolicatedStack?.[0].original ?? null).toBeNull()
  })

  it('非法 map / 未注册 apikey 的上传被拒绝', async () => {
    const bad = await postJson('/api/sourcemaps', {
      apikey: 'k',
      release: 'v1',
      url: 'a.js',
      map: 'not-json{{',
    })
    expect([400, 404]).toContain(bad.status)

    const unknown = await postJson('/api/sourcemaps', {
      apikey: 'ghost',
      release: 'v1',
      url: 'a.js',
      map: '{"version":3,"mappings":"AAAA"}',
    })
    expect(unknown.status).toBe(404)
  })
})

/** 与 main.ts 同款 body 解析 */
import express from 'express'
function expressJsonForTest(): express.RequestHandler {
  return express.json({ type: () => true, limit: '256kb' })
}
