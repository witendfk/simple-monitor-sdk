/**
 * 应用装配：按配置选择队列/存储/限流实现（内存 or 基础设施），
 * 全部经显式 token 注入（vitest esbuild 无 emitDecoratorMetadata，显式 token
 * 让测试环境零特殊处理——可测试性优先）。
 */
import { Module } from '@nestjs/common'
import { loadConfig, type ServerConfig } from './config'
import { ProjectsService } from './projects/projects.service'
import { QUEUE_TOKEN, type IEventQueue } from './queue/event-queue'
import { MemoryQueue } from './queue/memory.queue'
import { RedisStreamQueue } from './queue/redis-stream.queue'
import { STORAGE_TOKEN, type IEventStorage } from './storage/event-storage'
import { MemoryStorage } from './storage/memory.storage'
import { ClickHouseStorage } from './storage/clickhouse.storage'
import {
  RATE_LIMITER_TOKEN,
  MemoryRateLimiter,
  type IRateLimiter,
  RedisRateLimiter,
} from './report/rate-limiter'
import { ReportController, PROJECTS_TOKEN } from './report/report.controller'
import { IngestService } from './ingest/ingest.service'
import { SourcemapService } from './ingest/sourcemap.service'
import { QueryController } from './query/query.controller'

export const CONFIG_TOKEN = 'CONFIG'

@Module({
  controllers: [ReportController, QueryController],
  providers: [
    { provide: CONFIG_TOKEN, useValue: loadConfig() },
    {
      provide: PROJECTS_TOKEN,
      inject: [CONFIG_TOKEN],
      useFactory: (config: ServerConfig) => ProjectsService.fromJson(config.projectsJson),
    },
    {
      provide: QUEUE_TOKEN,
      inject: [CONFIG_TOKEN],
      useFactory: (config: ServerConfig): IEventQueue =>
        config.redisUrl ? new RedisStreamQueue(config.redisUrl) : new MemoryQueue(),
    },
    {
      provide: STORAGE_TOKEN,
      inject: [CONFIG_TOKEN],
      useFactory: (config: ServerConfig): IEventStorage =>
        config.clickhouseUrl ? new ClickHouseStorage(config.clickhouseUrl) : new MemoryStorage(),
    },
    {
      provide: RATE_LIMITER_TOKEN,
      inject: [CONFIG_TOKEN],
      useFactory: (config: ServerConfig): IRateLimiter =>
        config.redisUrl ? new RedisRateLimiter(config.redisUrl) : new MemoryRateLimiter(),
    },
    IngestService,
    SourcemapService,
  ],
})
export class AppModule {}
