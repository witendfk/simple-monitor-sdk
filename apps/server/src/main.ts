/**
 * 服务端入口：CORS 回显 origin + credentials（SDK 上报 withCredentials=true），
 * body 解析用 express.json({ type: () => true })——sendBeacon 通道 Content-Type
 * 是 text/plain，默认 json parser 不解析（总纲 §6.2 已记录的坑）。
 */
import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import express from 'express'
import { AppModule } from './app.module'
import { loadConfig } from './config'
import { IngestService } from './ingest/ingest.service'
import { AlertEngine } from './alert/alert-engine'

async function bootstrap(): Promise<void> {
  const config = loadConfig()
  const app = await NestFactory.create(AppModule, { bodyParser: false })

  // beacon 兼容：一切 Content-Type 都按 JSON 解析（解析失败由协议校验层拒绝）
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
