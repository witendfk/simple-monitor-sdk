/**
 * ClickHouse DateTime 无时区语义（镜像默认 UTC）：写入与查询参数边界统一格式化为
 * UTC 'YYYY-MM-DD HH:MM:SS'。ISO 8601（T/毫秒/Z）CH 不接受——旧实现 insert 侧留了
 * 毫秒、查询参数传完整 ISO，分别以 CANNOT_PARSE_INPUT / BAD_QUERY_PARAMETER 失败
 * （P2 挂账「CH 写入/查询时区格式不一致」的实锤与修复，2026-10-12 infra 冒烟发现）。
 */
export function toClickHouseDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}
