/**
 * SourceMap 工件存储 + 符号化服务。
 *
 * 契约：构建后 CLI 把 (apikey, release, 压缩文件 URL, map) 上传到服务端；
 * 错误详情查询时按 release + URL 匹配工件，用 trace-mapping 把
 * url:line:column 还原为原始 source:line:column:name。
 *
 * DIP（M7.5 P1）：ISourcemapArtifactStore 接口 + 双实现——
 *  - MemorySourcemapArtifactStore（内存，重启即失）；
 *  - PgSourcemapArtifactStore（storage/pg/，PG_URL 在位时启用）。
 * TraceMap 解析缓存保留在服务内存（解析一次多次查询，与存储形态无关）。
 * 匹配策略：URL 精确命中优先，其次后缀匹配（bundle 带域名/hash 时 CLI 侧
 * 通常传文件名或路径，后缀匹配覆盖 CDN 域名差异）。
 */
import { Injectable } from '@nestjs/common'
import { TraceMap, originalPositionFor, type SourceMapInput } from '@jridgewell/trace-mapping'

export const SOURCEMAP_ARTIFACT_STORE_TOKEN = 'SOURCEMAP_ARTIFACT_STORE'

export interface SourcemapArtifact {
  apikey: string
  release: string
  /** 压缩文件的 URL 或路径（精确或后缀匹配） */
  url: string
  /** source map JSON（原始内容存储，查询时解析） */
  mapJson: string
  uploadedAt: number
}

export interface ISourcemapArtifactStore {
  upsert(artifact: SourcemapArtifact): Promise<void>
  listByRelease(apikey: string, release: string): Promise<SourcemapArtifact[]>
  count(): Promise<number>
}

/** 内存实现：本地零依赖形态与单测用 */
export class MemorySourcemapArtifactStore implements ISourcemapArtifactStore {
  private readonly artifacts = new Map<string, SourcemapArtifact>()

  private key(apikey: string, release: string, url: string): string {
    return `${apikey}|${release}|${url}`
  }

  async upsert(artifact: SourcemapArtifact): Promise<void> {
    this.artifacts.set(this.key(artifact.apikey, artifact.release, artifact.url), artifact)
  }

  async count(): Promise<number> {
    return this.artifacts.size
  }

  async listByRelease(apikey: string, release: string): Promise<SourcemapArtifact[]> {
    return [...this.artifacts.values()].filter((a) => a.apikey === apikey && a.release === release)
  }
}

/** 符号化后的帧：原始位置信息（无法还原时 original 为空） */
export interface SymbolicatedFrame {
  url?: string | null
  func?: string | null
  line?: number | null
  column?: number | null
  original?: {
    source: string
    line: number | null
    column: number | null
    name?: string | null
  } | null
}

@Injectable()
export class SourcemapService {
  private readonly store: ISourcemapArtifactStore
  /** 已解析的 map 缓存（TraceMap 解析一次多次查询） */
  private readonly parsed = new Map<string, TraceMap>()

  constructor(store: ISourcemapArtifactStore = new MemorySourcemapArtifactStore()) {
    this.store = store
  }

  async upload(artifact: SourcemapArtifact): Promise<void> {
    await this.store.upsert(artifact)
    this.parsed.delete(`${artifact.apikey}|${artifact.release}|${artifact.url}`)
  }

  async count(): Promise<number> {
    return this.store.count()
  }

  /** release + url → 工件（精确 → 后缀） */
  private async find(
    apikey: string,
    release: string,
    url: string
  ): Promise<SourcemapArtifact | null> {
    const candidates = await this.store.listByRelease(apikey, release)
    const exact = candidates.find((a) => a.url === url)
    if (exact) return exact
    return candidates.find((a) => url.endsWith(a.url) || a.url.endsWith(url)) ?? null
  }

  /** 单帧符号化：无法匹配工件/还原失败时返回原帧（original 为 null，不阻断） */
  async symbolicateFrame(
    apikey: string,
    release: string | undefined,
    frame: SymbolicatedFrame
  ): Promise<SymbolicatedFrame> {
    if (!release || !frame.url || !frame.line) return { ...frame, original: null }
    const artifact = await this.find(apikey, release, frame.url)
    if (!artifact) return { ...frame, original: null }

    const cacheKey = `${artifact.apikey}|${artifact.release}|${artifact.url}`
    let map = this.parsed.get(cacheKey)
    if (!map) {
      try {
        map = new TraceMap(JSON.parse(artifact.mapJson) as SourceMapInput)
        this.parsed.set(cacheKey, map)
      } catch {
        return { ...frame, original: null }
      }
    }
    try {
      const pos = originalPositionFor(map, {
        line: frame.line,
        column: (frame.column ?? 1) - 1,
      })
      if (!pos.source) return { ...frame, original: null }
      return {
        ...frame,
        original: {
          source: pos.source,
          line: pos.line === null ? null : pos.line + 1,
          column: pos.column === null ? null : pos.column + 1,
          name: pos.name ?? null,
        },
      }
    } catch {
      return { ...frame, original: null }
    }
  }

  /** 整组堆栈符号化 */
  async symbolicateStack(
    apikey: string,
    release: string | undefined,
    frames: SymbolicatedFrame[]
  ): Promise<SymbolicatedFrame[]> {
    return Promise.all(frames.map((f) => this.symbolicateFrame(apikey, release, f)))
  }
}
