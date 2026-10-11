/**
 * 服务端入口：CORS 回显 origin + credentials（SDK 上报 withCredentials=true），
 * body 解析用 express.json({ type: () => true })——sendBeacon 通道 Content-Type
 * 是 text/plain，默认 json parser 不解析（docs/SPEC.md §4.1 beacon 兼容）。
 */
import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import express from 'express'
import { AppModule } from './app.module'
import { loadConfig } from './config'
import { gunzipBody } from './report/gunzip-body.middleware'
import { IngestService } from './ingest/ingest.service'
import { AlertEngine } from './alert/alert-engine'

async function bootstrap(): Promise<void> {
  const config = loadConfig()
  const app = await NestFactory.create(AppModule, { bodyParser: false })

  // beacon 兼容：一切 Content-Type 都按 JSON 解析（解析失败由协议校验层拒绝）
  app.use(gunzipBody)
  // sourcemap 工件（真实项目 map 常为 MB 级）单独放开上限；其余路由维持 256kb
  app.use('/api/sourcemaps', express.json({ type: () => true, limit: '20mb' }))
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
