/**
 * 服务端入口：CORS 回显 origin + credentials（SDK 上报 withCredentials=true），
 * body 解析用 express.json({ type: () => true })——sendBeacon 通道 Content-Type
 * 是 text/plain，默认 json parser 不解析（总纲 §6.2 已记录的坑）。
 */
import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import express from 'express'
import zlib from 'node:zlib'
import { AppModule } from './app.module'
import { loadConfig } from './config'
import { IngestService } from './ingest/ingest.service'
import { AlertEngine } from './alert/alert-engine'

/**
 * gzip 信封解压（M2 SDK 会对 >1KB 的信封走 CompressionStream，Content-Type
 * application/gzip）：在 JSON 解析前解包。累计上限 1MB 防解压炸弹——
 * 正常信封压缩后远小于此（该缺口曾由 demo-app 富信封链路暴露，总纲 §3.8 后记）。
 */
function gunzipBody(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const contentType = req.headers['content-type'] ?? ''
  if (!String(contentType).includes('application/gzip')) {
    next()
    return
  }
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > 1024 * 1024) {
      overflow = true
      res.status(413).json({ error: 'gzip body too large' })
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (overflow) return
    try {
      const plain = zlib.gunzipSync(Buffer.concat(chunks)).toString('utf8')
      req.body = JSON.parse(plain)
      // body-parser 看到 _body=true 会跳过读取（此时流已被本中间件消费完）
      ;(req as express.Request & { _body?: boolean })._body = true
      next()
    } catch {
      res.status(400).json({ error: 'invalid gzip body' })
    }
  })
}

async function bootstrap(): Promise<void> {
  const config = loadConfig()
  const app = await NestFactory.create(AppModule, { bodyParser: false })

  // beacon 兼容：一切 Content-Type 都按 JSON 解析（解析失败由协议校验层拒绝）
  app.use(gunzipBody)
  app.use(express.json({ type: () => true, limit: '256kb' }))
  app.enableCors({ origin: true, credentials: true })
  app.enableShutdownHooks()

  const port = config.port
  await app.listen(port)

  // 启动消费循环 + 告警评估（模块销毁时经 OnApplicationShutdown 优雅停止）
  app.get(IngestService).start()
  app.get(AlertEngine).start()

  const mode = (url?: string): string => (url ? 'infra' : 'memory')
  Logger.log(
    `server up on :${port} | queue=${mode(config.redisUrl)} storage=${mode(config.clickhouseUrl)} projects=${
      config.projectsJson ? 'custom' : 'demo'
    }`,
    'Bootstrap'
  )
}

void bootstrap().catch((error) => {
  Logger.error(`bootstrap failed: ${String(error)}`)
  process.exit(1)
})
