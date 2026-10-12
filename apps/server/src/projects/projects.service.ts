/**
 * 项目注册表：公开上报标识（apikey）→ 项目配置（限流阈值等）。
 *
 * DIP（M7.5 P1）：IProjectStore 异步接口 + 双实现——
 *  - ProjectsService（内存实现）：env 注入 + 默认 demo 项目，零依赖形态与测试用；
 *  - PgProjectStore（storage/pg/）：PG_URL 在位时启用。
 *
 * 双密钥（P3 权限分离的数据地基）：apikey 为公开上报身份（嵌在宿主页面公开可见）；
 * secretKeyHash 为管理身份 sha256——P1 仅落数据列，鉴权切换归 P3。
 */
import { Injectable } from '@nestjs/common'
import { createHash } from 'node:crypto'

export interface Project {
  apikey: string
  name: string
  /** 每分钟上报信封上限（限流阈值） */
  rateLimitPerMin: number
  /** 管理身份密钥哈希（sha256 hex）；P3 启用前不参与任何鉴权判断 */
  secretKeyHash?: string
}

export interface IProjectStore {
  exists(apikey: string): Promise<boolean>
  get(apikey: string): Promise<Project | undefined>
}

export function hashSecretKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** PROJECTS_JSON → Project[]（PG 形态作为幂等种子；非法/空输入返回 [] 不抛出） */
export function parseProjectsSeed(json: string | undefined): Project[] {
  if (!json) return []
  try {
    const raw: unknown = JSON.parse(json)
    if (!Array.isArray(raw)) return []
    return raw
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map((p) => ({
        apikey: String(p['apikey'] ?? ''),
        name: String(p['name'] ?? ''),
        rateLimitPerMin: Number(p['rateLimitPerMin'] ?? 1000),
        ...(typeof p['secretKey'] === 'string' && p['secretKey'].length > 0
          ? { secretKeyHash: hashSecretKey(p['secretKey']) }
          : {}),
      }))
      .filter((p) => p.apikey.length > 0)
  } catch {
    return []
  }
}

const DEFAULT_PROJECTS: Project[] = [{ apikey: 'demo-key', name: 'demo', rateLimitPerMin: 1000 }]

@Injectable()
export class ProjectsService implements IProjectStore {
  private readonly byKey = new Map<string, Project>()

  constructor(projects?: Project[]) {
    for (const p of projects ?? DEFAULT_PROJECTS) {
      this.byKey.set(p.apikey, p)
    }
  }

  static fromJson(json: string | undefined): ProjectsService {
    const projects = parseProjectsSeed(json)
    return new ProjectsService(projects.length > 0 ? projects : undefined)
  }

  /** apikey 是否有效 */
  async exists(apikey: string): Promise<boolean> {
    return this.byKey.has(apikey)
  }

  async get(apikey: string): Promise<Project | undefined> {
    return this.byKey.get(apikey)
  }
}
