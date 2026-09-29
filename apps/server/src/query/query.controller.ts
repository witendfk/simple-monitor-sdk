/**
 * 查询 API（看板数据源）：概览 / 错误组 / 错误详情 / 性能分位。
 * 只面向 IEventStorage 接口——内存与 ClickHouse 实现对查询方透明。
 */
import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common'
import { STORAGE_TOKEN, type IEventStorage } from '../storage/event-storage'

@Controller('api')
export class QueryController {
  constructor(@Inject(STORAGE_TOKEN) private readonly storage: IEventStorage) {}

  /** GET /api/overview?sinceMinutes=60 */
  @Get('overview')
  overview(@Query('sinceMinutes') sinceMinutes?: string) {
    return this.storage.overview(parseSince(sinceMinutes, 60))
  }

  /** GET /api/errors?limit=50&sinceMinutes=10080 */
  @Get('errors')
  errors(@Query('limit') limit?: string, @Query('sinceMinutes') sinceMinutes?: string) {
    return this.storage.errorGroups(
      clamp(Number(limit) || 50, 1, 200),
      parseSince(sinceMinutes, 7 * 24 * 60)
    )
  }

  /** GET /api/errors/:fingerprint */
  @Get('errors/:fingerprint')
  async errorDetail(@Param('fingerprint') fingerprint: string) {
    const detail = await this.storage.errorDetail(fingerprint)
    if (!detail) throw new NotFoundException({ error: 'fingerprint not found' })
    return detail
  }

  /** GET /api/performance?metric=largest-contentful-paint&sinceMinutes=1440 */
  @Get('performance')
  performance(
    @Query('metric') metric = 'largest-contentful-paint',
    @Query('sinceMinutes') sinceMinutes?: string
  ) {
    return this.storage.performanceQuantiles(metric, parseSince(sinceMinutes, 24 * 60))
  }
}

function parseSince(sinceMinutes: string | undefined, defaultMinutes: number): number {
  const n = Number(sinceMinutes)
  return (Number.isFinite(n) && n > 0 ? n : defaultMinutes) * 60_000
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}
