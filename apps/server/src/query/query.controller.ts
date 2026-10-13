/**
 * 查询 API（看板数据源）：概览 / 错误组 / 错误详情 / 性能分位。
 * 只面向 IEventStorage 接口——内存与 ClickHouse 实现对查询方透明。
 * 鉴权（M7.5 P3 权限分离）：ManagementGuard（会话/项目密钥双通道）+ 全部查询按 req.apikey 隔离。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Put,
  UseGuards,
} from '@nestjs/common'
import { z } from 'zod'
import { PROJECTS_TOKEN } from '../report/report.controller'
import { ProjectsService } from '../projects/projects.service'
import { ManagementGuard, type AuthedRequest } from '../auth/management.guard'
import { STORAGE_TOKEN, type IEventStorage } from '../storage/event-storage'
import { SourcemapService } from '../ingest/sourcemap.service'
import { computeHealthScore } from './health'
import { ISSUE_STORE_TOKEN, type IIssueStore, type IssueStatus } from '../storage/issue-store'

/** class 型参数一律显式 @Inject（vitest esbuild 无 design:paramTypes 元数据） */

@Controller('api')
@UseGuards(ManagementGuard)
export class QueryController {
  constructor(
    @Inject(STORAGE_TOKEN) private readonly storage: IEventStorage,
    @Inject(PROJECTS_TOKEN) private readonly projects: ProjectsService,
    @Inject(SourcemapService) private readonly sourcemaps: SourcemapService,
    @Inject(ISSUE_STORE_TOKEN) private readonly issues: IIssueStore
  ) {}

  /** GET /api/overview?sinceMinutes=60 */
  @Get('overview')
  async overview(@Req() req: AuthedRequest, @Query('sinceMinutes') sinceMinutes?: string) {
    const apikey = req.apikey
    const sinceMin = parseSince(sinceMinutes, 60)
    const stats = await this.storage.overview(apikey, sinceMin)
    // 健康度（P5b）：从既有查询拼装快照 → 确定性扣分
    const groups = await this.storage.errorGroups(apikey, 200, sinceMin)
    const ajaxErrorCount = groups
      .filter((g) => g.type === 'HTTP_ERROR')
      .reduce((sum, g) => sum + g.count, 0)
    const resourceFailCount = groups
      .filter((g) => g.type === 'RESOURCE_ERROR')
      .reduce((sum, g) => sum + g.count, 0)
    const lcp = await this.storage.performanceQuantiles(
      apikey,
      'largest-contentful-paint',
      sinceMin
    )
    const health = computeHealthScore({
      errorCount: stats.errorCount,
      ajaxErrorCount,
      resourceFailCount,
      lcpP75: lcp.p75,
    })
    return { ...stats, health }
  }

  /** GET /api/errors?limit=50&sinceMinutes=10080 */
  @Get('errors')
  async errors(
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('sinceMinutes') sinceMinutes?: string
  ) {
    const groups = await this.storage.errorGroups(
      req.apikey,
      clamp(Number(limit) || 50, 1, 200),
      parseSince(sinceMinutes, 7 * 24 * 60)
    )
    // 状态透出（PG issues / Memory 状态机；未知指纹视为 open）
    const statuses = await this.issues.getStatuses(
      req.apikey,
      groups.map((g) => g.fingerprint)
    )
    return groups.map((g) => ({
      ...g,
      status: statuses.get(g.fingerprint) ?? ('open' as const),
    }))
  }

  /** PUT /api/errors/:fingerprint/status —— 状态流转（open/resolved/ignored） */
  @Put('errors/:fingerprint/status')
  async setStatus(
    @Req() req: AuthedRequest,
    @Param('fingerprint') fingerprint: string,
    @Body() body: unknown
  ): Promise<{ ok: true; status: IssueStatus }> {
    const parsed = z.object({ status: z.enum(['open', 'resolved', 'ignored']) }).safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({ error: 'invalid status', issues: parsed.error.issues })
    }
    await this.issues.setStatus(req.apikey, fingerprint, parsed.data.status)
    return { ok: true, status: parsed.data.status }
  }

  /** GET /api/errors/trend?hours=24 —— 错误趋势小时桶（P5b） */
  @Get('errors/trend')
  async errorTrend(@Req() req: AuthedRequest, @Query('hours') hours?: string) {
    const buckets = await this.storage.errorTrend(req.apikey, clamp(Number(hours) || 24, 1, 168))
    return { hours: clamp(Number(hours) || 24, 1, 168), buckets }
  }

  /** GET /api/performance/by-page —— 页面维度 Vitals 分位排行（P5b） */
  @Get('performance/by-page')
  performanceByPage(@Req() req: AuthedRequest, @Query('sinceMinutes') sinceMinutes?: string) {
    return this.storage.performanceByPage(req.apikey, parseSince(sinceMinutes, 60 * 24))
  }

  /**
   * GET /api/errors/:fingerprint
   * 详情样本附 symbolicatedStack：按 release+URL 匹配已上传的 SourceMap
   * 将压缩帧还原为原始 source:line:column（无法还原的帧 original=null 透传）
   */
  @Get('errors/:fingerprint')
  async errorDetail(@Req() req: AuthedRequest, @Param('fingerprint') fingerprint: string) {
    const detail = await this.storage.errorDetail(req.apikey, fingerprint)
    if (!detail) throw new NotFoundException({ error: 'fingerprint not found' })
    const rawFrames = detail.error?.stackFrames ?? []
    const symbolicatedStack = await this.sourcemaps.symbolicateStack(
      detail.apikey,
      detail.release,
      rawFrames.map((f) => ({ ...f }))
    )
    return { ...detail, symbolicatedStack }
  }

  /**
   * POST /api/sourcemaps —— 构建后 CLI 上传工件
   * body: { release, url, map }（apikey 取鉴权头，防跨项目投毒工件）
   */
  @Post('sourcemaps')
  @HttpCode(201)
  async uploadSourcemap(
    @Req() req: AuthedRequest,
    @Body() body: unknown
  ): Promise<{ ok: true; stored: number }> {
    const schema = z.object({
      release: z.string().min(1),
      url: z.string().min(1),
      map: z.string().min(1),
    })
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({ error: 'invalid sourcemap payload' })
    }
    // map 内容 fail-fast 校验（Sentry 惯例）：坏 map 上传成功只会把问题推迟到查询时
    let mapContent: { version?: unknown; mappings?: unknown }
    try {
      mapContent = JSON.parse(parsed.data.map)
    } catch {
      throw new BadRequestException({ error: 'map is not valid JSON' })
    }
    if (typeof mapContent.version !== 'number' || typeof mapContent.mappings !== 'string') {
      throw new BadRequestException({ error: 'map missing version/mappings' })
    }
    const { release, url, map } = parsed.data
    await this.sourcemaps.upload({
      apikey: req.apikey,
      release,
      url,
      mapJson: map,
      uploadedAt: Date.now(),
    })
    return { ok: true, stored: await this.sourcemaps.count() }
  }

  /** GET /api/behaviors?limit=20 —— 最近行为事件（M7 冒烟；M9 事件浏览器雏形） */
  @Get('behaviors')
  behaviors(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.storage.recentBehaviors(req.apikey, clamp(Number(limit) || 20, 1, 200))
  }

  /** GET /api/performance?metric=largest-contentful-paint&sinceMinutes=1440 */
  @Get('performance')
  performance(
    @Req() req: AuthedRequest,
    @Query('metric') metric = 'largest-contentful-paint',
    @Query('sinceMinutes') sinceMinutes?: string
  ) {
    return this.storage.performanceQuantiles(req.apikey, metric, parseSince(sinceMinutes, 24 * 60))
  }
}

function parseSince(sinceMinutes: string | undefined, defaultMinutes: number): number {
  const n = Number(sinceMinutes)
  // 上界 10 年：极端值会让 Date 越界成 Invalid Date（.toISOString 抛 RangeError → 500）
  return (Number.isFinite(n) && n > 0 ? Math.min(n, 10 * 365 * 24 * 60) : defaultMinutes) * 60_000
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
