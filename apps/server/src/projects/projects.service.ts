/**
 * 项目注册表：apikey → 项目配置（限流阈值等）。
 *
 * M4 起步为内存注册表（env 注入 + 默认 demo 项目）；Postgres 元数据表
 * 在 M4 后续切片替换实现——接口保持稳定（DIP）。
 */
import { Injectable } from '@nestjs/common'

export interface Project {
  apikey: string
  name: string
  /** 每分钟上报信封上限（限流阈值） */
  rateLimitPerMin: number
}

const DEFAULT_PROJECTS: Project[] = [{ apikey: 'demo-key', name: 'demo', rateLimitPerMin: 1000 }]

@Injectable()
export class ProjectsService {
  private readonly byKey = new Map<string, Project>()

  constructor(projects?: Project[]) {
    for (const p of projects ?? DEFAULT_PROJECTS) {
      this.byKey.set(p.apikey, p)
    }
  }

  static fromJson(json: string | undefined): ProjectsService {
    if (!json) return new ProjectsService()
    try {
      const raw: unknown = JSON.parse(json)
      if (!Array.isArray(raw)) return new ProjectsService()
      const projects = raw
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map((p) => ({
          apikey: String(p['apikey'] ?? ''),
          name: String(p['name'] ?? ''),
          rateLimitPerMin: Number(p['rateLimitPerMin'] ?? 1000),
        }))
        .filter((p) => p.apikey.length > 0)
      return new ProjectsService(projects.length > 0 ? projects : undefined)
    } catch {
      return new ProjectsService()
    }
  }

  /** apikey 是否有效 */
  exists(apikey: string): boolean {
    return this.byKey.has(apikey)
  }

  get(apikey: string): Project | undefined {
    return this.byKey.get(apikey)
  }
}
