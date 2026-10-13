/**
 * 应用装配：按配置选择队列/存储/限流/元数据实现（内存 or 基础设施），
 * 全部经显式 token 注入（vitest esbuild 无 emitDecoratorMetadata，显式 token
 * 让测试环境零特殊处理——可测试性优先）。
 *
 * M7.5 P1：PG_URL 在位时元数据域切 PG 实现（项目/告警规则/SourceMap 工件/Issue
 * 状态机），共用一个连接池（PG_POOL_TOKEN）；内存实现永久保留为零依赖形态（DIP）。
 * infra 开关现状为各 URL 环境变量在位即启用；NODE_STORAGE 一键切换属 M7.5 目标。
 */
import { Module } from '@nestjs/common'
import type { Pool } from 'pg'
import { FetchWebhookSender } from './alert/alert-engine'
import { loadConfig, CONFIG_TOKEN, type ServerConfig } from './config'
import { parseProjectsSeed, ProjectsService, type IProjectStore } from './projects/projects.service'
import { PROJECTS_TOKEN } from './report/report.controller'
import { USER_STORE_TOKEN, MemoryUserStore, type IUserStore } from './auth/user.store'
import { PgUserStore } from './storage/pg/pg-user.store'
import { AuthController } from './auth/auth.controller'
import { hashPassword } from './auth/password'
import { QUEUE_TOKEN, type IEventQueue } from './queue/event-queue'
import { MemoryQueue } from './queue/memory.queue'
import { RedisStreamQueue } from './queue/redis-stream.queue'
import { STORAGE_TOKEN, type IEventStorage } from './storage/event-storage'
import { MemoryStorage } from './storage/memory.storage'
import { ClickHouseStorage } from './storage/clickhouse.storage'
import { ISSUE_STORE_TOKEN, MemoryIssueStore, type IIssueStore } from './storage/issue-store'
import { createPgPool } from './storage/pg/pg.client'
import { PgProjectStore } from './storage/pg/pg-project.store'
import { PgAlertRuleStore } from './storage/pg/pg-alert-rule.store'
import { PgSourcemapArtifactStore } from './storage/pg/pg-sourcemap-artifact.store'
import { PgIssueStore } from './storage/pg/pg-issue.store'
import {
  RATE_LIMITER_TOKEN,
  MemoryRateLimiter,
  type IRateLimiter,
  RedisRateLimiter,
} from './report/rate-limiter'
import { ReportController } from './report/report.controller'
import { IngestService } from './ingest/ingest.service'
import {
  SOURCEMAP_ARTIFACT_STORE_TOKEN,
  MemorySourcemapArtifactStore,
  SourcemapService,
  type ISourcemapArtifactStore,
} from './ingest/sourcemap.service'
import { ALERT_RULE_STORE_TOKEN, AlertRuleStore, type IAlertRuleStore } from './alert/rule-store'
import { AlertEngine } from './alert/alert-engine'
import { AlertRulesController, AlertFiresController } from './alert/alert.controller'
import { QueryController } from './query/query.controller'

export const PG_POOL_TOKEN = 'PG_POOL'

@Module({
  controllers: [
    ReportController,
    QueryController,
    AlertRulesController,
    AlertFiresController,
    AuthController,
  ],
  providers: [
    { provide: CONFIG_TOKEN, useValue: loadConfig() },
    {
      // 单例连接池：PG_URL 未配置时为 null（内存形态，各 store 工厂自行回落）
      provide: PG_POOL_TOKEN,
      inject: [CONFIG_TOKEN],
      useFactory: (config: ServerConfig): Pool | null =>
        config.pgUrl ? createPgPool(config.pgUrl) : null,
    },
    {
      // PG 形态：PROJECTS_JSON 幂等种子入库（无种子时表空则落 demo 保底）
      provide: PROJECTS_TOKEN,
      inject: [CONFIG_TOKEN, PG_POOL_TOKEN],
      useFactory: async (config: ServerConfig, pool: Pool | null): Promise<IProjectStore> => {
        if (!pool) return ProjectsService.fromJson(config.projectsJson)
        const store = new PgProjectStore(pool)
        const seed = parseProjectsSeed(config.projectsJson)
        await store.ensureProjects(seed)
        if (seed.length === 0) await store.ensureDemoFallback()
        return store
      },
    },
    {
      // 管理身份存储（M7.5 P3）：依赖 PROJECTS_TOKEN 保证项目种子先于成员绑定
      provide: USER_STORE_TOKEN,
      inject: [CONFIG_TOKEN, PG_POOL_TOKEN, PROJECTS_TOKEN],
      useFactory: async (
        config: ServerConfig,
        pool: Pool | null,
        _projects: IProjectStore
      ): Promise<IUserStore> => {
        const store = pool ? new PgUserStore(pool) : new MemoryUserStore(parseProjectsSeed(config.projectsJson)[0]?.apikey ?? 'demo-key')
        const firstKey = parseProjectsSeed(config.projectsJson)[0]?.apikey ?? 'demo-key'
        await store.ensureUser(
          config.adminEmail ?? 'admin@demo.local',
          hashPassword(config.adminPassword ?? 'demo-password')
        )
        await store.bindProjectByEmail(config.adminEmail ?? 'admin@demo.local', firstKey)
        return store
      },
    },
    {
      // 管理身份存储（M7.5 P3）：依赖 PROJECTS_TOKEN 保证项目种子先于成员绑定
      provide: USER_STORE_TOKEN,
      inject: [CONFIG_TOKEN, PG_POOL_TOKEN, PROJECTS_TOKEN],
      useFactory: async (
        config: ServerConfig,
        pool: Pool | null,
        _projects: IProjectStore
      ): Promise<IUserStore> => {
        const firstKey =
          parseProjectsSeed(config.projectsJson)[0]?.apikey ?? 'demo-key'
        const store = pool ? new PgUserStore(pool) : new MemoryUserStore(firstKey)
        await store.ensureUser(
          config.adminEmail ?? 'admin@demo.local',
          hashPassword(config.adminPassword ?? 'demo-password')
        )
        await store.bindProjectByEmail(config.adminEmail ?? 'admin@demo.local', firstKey)
        return store
      },
    },
    {
      provide: ALERT_RULE_STORE_TOKEN,
      inject: [PG_POOL_TOKEN],
      useFactory: (pool: Pool | null): IAlertRuleStore =>
        pool ? new PgAlertRuleStore(pool) : new AlertRuleStore(),
    },
    {
      provide: SOURCEMAP_ARTIFACT_STORE_TOKEN,
      inject: [PG_POOL_TOKEN],
      useFactory: (pool: Pool | null): ISourcemapArtifactStore =>
        pool ? new PgSourcemapArtifactStore(pool) : new MemorySourcemapArtifactStore(),
    },
    {
      provide: ISSUE_STORE_TOKEN,
      inject: [PG_POOL_TOKEN],
      useFactory: (pool: Pool | null): IIssueStore =>
        pool ? new PgIssueStore(pool) : new MemoryIssueStore(),
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
        config.clickhouseUrl
          ? new ClickHouseStorage(
              config.clickhouseUrl,
              config.clickhouseUsername,
              config.clickhousePassword
            )
          : new MemoryStorage(),
    },
    {
      provide: RATE_LIMITER_TOKEN,
      inject: [CONFIG_TOKEN],
      useFactory: (config: ServerConfig): IRateLimiter =>
        config.redisUrl ? new RedisRateLimiter(config.redisUrl) : new MemoryRateLimiter(),
    },
    {
      provide: SourcemapService,
      inject: [SOURCEMAP_ARTIFACT_STORE_TOKEN],
      useFactory: (store: ISourcemapArtifactStore) => new SourcemapService(store),
    },
    IngestService,
    {
      provide: AlertEngine,
      inject: [STORAGE_TOKEN, ALERT_RULE_STORE_TOKEN, CONFIG_TOKEN],
      useFactory: (storage: IEventStorage, store: IAlertRuleStore, config: ServerConfig) =>
        new AlertEngine(
          storage,
          store,
          new FetchWebhookSender({ allowPrivate: config.webhookAllowPrivate }),
          // 评估周期：测试/演示可用 ALERT_CHECK_INTERVAL_MS 调小
          Number(process.env.ALERT_CHECK_INTERVAL_MS) || 5 * 60_000
        ),
    },
  ],
})
export class AppModule {}
