/**
 * SourceMap 工件存储 + 符号化服务。
 *
 * 契约：构建后 CLI 把 (apikey, release, 压缩文件 URL, map) 上传到服务端；
 * 错误详情查询时按 release + URL 匹配工件，用 trace-mapping 把
 * url:line:column 还原为原始 source:line:column:name。
 *
 * 存储为内存实现（重启即失，M4 后续切片接 Postgres/对象存储——接口保持稳定）。
 * 匹配策略：URL 精确命中优先，其次后缀匹配（bundle 带域名/hash 时 CLI 侧
 * 通常传文件名或路径，后缀匹配覆盖 CDN 域名差异）。
 */
import { Injectable } from '@nestjs/common'
import { TraceMap, originalPositionFor, type SourceMapInput } from '@jridgewell/trace-mapping'

export interface SourcemapArtifact {
  apikey: string
  release: string
  /** 压缩文件的 URL 或路径（精确或后缀匹配） */
  url: string
  /** source map JSON（原始内容存储，查询时解析） */
  mapJson: string
  uploadedAt: number
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
  /** key: apikey|release|url */
  private readonly artifacts = new Map<string, SourcemapArtifact>()
  /** 已解析的 map 缓存（TraceMap 解析一次多次查询） */
  private readonly parsed = new Map<string, TraceMap>()

  private key(apikey: string, release: string, url: string): string {
    return `${apikey}|${release}|${url}`
  }

  upload(artifact: SourcemapArtifact): void {
    this.artifacts.set(this.key(artifact.apikey, artifact.release, artifact.url), artifact)
    this.parsed.delete(this.key(artifact.apikey, artifact.release, artifact.url))
  }

  count(): number {
    return this.artifacts.size
  }

  /** release + url → 工件（精确 → 后缀） */
  private find(apikey: string, release: string, url: string): SourcemapArtifact | null {
    const exact = this.artifacts.get(this.key(apikey, release, url))
    if (exact) return exact
    for (const artifact of this.artifacts.values()) {
      if (artifact.apikey !== apikey || artifact.release !== release) continue
      if (url.endsWith(artifact.url) || artifact.url.endsWith(url)) return artifact
    }
    return null
  }

  /** 单帧符号化：无法匹配工件/还原失败时返回原帧（original 为 null，不阻断） */
  symbolicateFrame(
    apikey: string,
    release: string | undefined,
    frame: SymbolicatedFrame
  ): SymbolicatedFrame {
    if (!release || !frame.url || !frame.line) return { ...frame, original: null }
    const artifact = this.find(apikey, release, frame.url)
    if (!artifact) return { ...frame, original: null }

    const cacheKey = this.key(artifact.apikey, artifact.release, artifact.url)
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
  symbolicateStack(
    apikey: string,
    release: string | undefined,
    frames: SymbolicatedFrame[]
  ): SymbolicatedFrame[] {
    return frames.map((f) => this.symbolicateFrame(apikey, release, f))
  }
}
