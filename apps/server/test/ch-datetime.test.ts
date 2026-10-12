/**
 * ClickHouse DateTime 边界格式化（infra 冒烟发现）：写入留毫秒、查询传完整 ISO
 * 分别触发 CANNOT_PARSE_INPUT / BAD_QUERY_PARAMETER——边界统一 UTC 短格式
 */
import { describe, it, expect } from 'vitest'
import { toClickHouseDateTime } from '../src/storage/clickhouse.storage'

describe('toClickHouseDateTime', () => {
  it('ISO（T/毫秒/Z）→ UTC YYYY-MM-DD HH:MM:SS', () => {
    expect(toClickHouseDateTime(new Date('2026-10-12T00:57:52.789Z'))).toBe('2026-10-12 00:57:52')
  })
  it('零点与年末边界不进位不丢位', () => {
    expect(toClickHouseDateTime(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-31 23:59:59')
    expect(toClickHouseDateTime(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01 00:00:00')
  })
})
