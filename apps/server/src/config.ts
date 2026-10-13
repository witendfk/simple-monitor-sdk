/**
 * 服务端配置（zod 解析环境变量，启动期校验失败直接 fail-fast）
 *
 * 存在 REDIS_URL / CLICKHOUSE_URL 时启用对应基础设施实现，
 * 否则回落内存实现（本地开发 / 测试 / 演示零依赖跑通全链路）。
 */
import { z } from 'zod'

/** DI token：配置对象（放 config 而非 app.module，避免 controller → module 循环 import） */
export const CONFIG_TOKEN = 'CONFIG'

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  redisUrl: z.string().optional(),
  clickhouseUrl: z.string().optional(),
  /** Postgres 元数据域（M7.5 P1）：在位即启用 PG 实现（项目/告警规则/工件/Issue） */
  pgUrl: z.string().optional(),
  /** ClickHouse 凭证（官方镜像 24.x 起不再允许 default 空密码匿名） */
  clickhouseUsername: z.string().default('default'),
  clickhousePassword: z.string().default(''),
  /** 项目注册表 JSON：[{"apikey":"demo-key","name":"demo","rateLimitPerMin":1000}] */
  projectsJson: z.string().optional(),
  /** 本地演示放开 webhook 私网/环回限制（SSRF 防护默认开） */
  webhookAllowPrivate: z.boolean().default(false),
  /** 管理员种子与会话签名（M7.5 P3）：生产部署必须覆盖这三个默认值（server README 边界） */
  adminEmail: z.string().email().default('admin@demo.local'),
  adminPassword: z.string().min(1).default('demo-password'),
  sessionSecret: z.string().min(1).default('dev-insecure-session-secret'),
})

export interface ServerConfig {
  port: number
  redisUrl?: string
  clickhouseUrl?: string
  pgUrl?: string
  /** 缺省 default / 空密码（storage 侧构造参数兜底） */
  clickhouseUsername?: string
  clickhousePassword?: string
  projectsJson?: string
  webhookAllowPrivate: boolean
  /** 缺省 admin@demo.local / demo-password（zod default；测试可用 useValue 覆盖） */
  adminEmail?: string
  adminPassword?: string
  sessionSecret?: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = ConfigSchema.parse({
    port: env.PORT,
    redisUrl: env.REDIS_URL || undefined,
    clickhouseUrl: env.CLICKHOUSE_URL || undefined,
    pgUrl: env.PG_URL || undefined,
    clickhouseUsername: env.CLICKHOUSE_USERNAME || undefined,
    clickhousePassword: env.CLICKHOUSE_PASSWORD || '',
    projectsJson: env.PROJECTS_JSON || undefined,
    webhookAllowPrivate: env.WEBHOOK_ALLOW_PRIVATE === '1',
    adminEmail: env.ADMIN_EMAIL || undefined,
    adminPassword: env.ADMIN_PASSWORD || undefined,
    sessionSecret: env.ADMIN_SESSION_SECRET || undefined,
  })
  return parsed
}
