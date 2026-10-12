/**
 * SourceMap 工件 PG 实现（M7.5 P1）：sourcemap_artifacts 表（重启不再失，
 * 符号化能力跨进程存活——旧内存实现重启后静默退化为原始堆栈）。
 */
import type { Pool } from 'pg'
import type { ISourcemapArtifactStore, SourcemapArtifact } from '../../ingest/sourcemap.service'

export class PgSourcemapArtifactStore implements ISourcemapArtifactStore {
  constructor(private readonly pool: Pool) {}

  async upsert(artifact: SourcemapArtifact): Promise<void> {
    await this.pool.query(
      `INSERT INTO sourcemap_artifacts (project_id, release, url, map_json, uploaded_at)
       VALUES ((SELECT id FROM projects WHERE public_key = $1), $2, $3, $4, to_timestamp($5 / 1000.0))
       ON CONFLICT (project_id, release, url) DO UPDATE
       SET map_json = EXCLUDED.map_json, uploaded_at = EXCLUDED.uploaded_at`,
      [artifact.apikey, artifact.release, artifact.url, artifact.mapJson, artifact.uploadedAt]
    )
  }

  async count(): Promise<number> {
    const r = await this.pool.query('SELECT count(*)::int AS n FROM sourcemap_artifacts')
    return Number(r.rows[0]?.n ?? 0)
  }

  async listByRelease(apikey: string, release: string): Promise<SourcemapArtifact[]> {
    const r = await this.pool.query(
      `SELECT a.url, a.map_json, a.uploaded_at
       FROM sourcemap_artifacts a JOIN projects p ON p.id = a.project_id
       WHERE p.public_key = $1 AND a.release = $2`,
      [apikey, release]
    )
    return r.rows.map((row) => ({
      apikey,
      release,
      url: row.url,
      mapJson: row.map_json,
      uploadedAt: new Date(row.uploaded_at).getTime(),
    }))
  }
}
