/**
 * 服务端配置（zod 解析环境变量，启动期校验失败直接 fail-fast）
 *
 * 存在 REDIS_URL / CLICKHOUSE_URL 时启用对应基础设施实现，
 * 否则回落内存实现（本地开发 / 测试 / 演示零依赖跑通全链路）。
 */
import { z } from 'zod'

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  redisUrl: z.string().optional(),
  clickhouseUrl: z.string().optional(),
  /** 项目注册表 JSON：[{"apikey":"demo-key","name":"demo","rateLimitPerMin":1000}] */
  projectsJson: z.string().optional(),
})

export interface ServerConfig {
  port: number
  redisUrl?: string
  clickhouseUrl?: string
  projectsJson?: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = ConfigSchema.parse({
    port: env.PORT,
    redisUrl: env.REDIS_URL || undefined,
    clickhouseUrl: env.CLICKHOUSE_URL || undefined,
    projectsJson: env.PROJECTS_JSON || undefined,
  })
  return parsed
}
