/**
 * /api/** 统一鉴权（总纲 §3.7 P0-3）：x-api-key 头 → 项目注册表校验。
 *
 * 通过后把 apikey 挂到 req.apikey，下游 controller 用它做数据隔离
 * （P0-4：所有存储查询按 apikey 过滤，杜绝跨项目读数）。
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import { PROJECTS_TOKEN } from '../report/report.controller'
import { ProjectsService } from '../projects/projects.service'

/** class 型参数一律显式 @Inject（vitest esbuild 无 design:paramTypes 元数据） */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(PROJECTS_TOKEN) private readonly projects: ProjectsService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { apikey?: string }>()
    const apikey = req.header('x-api-key')
    if (!apikey || !this.projects.exists(apikey)) {
      throw new UnauthorizedException({ error: 'missing or unknown x-api-key' })
    }
    req.apikey = apikey
    return true
  }
}
