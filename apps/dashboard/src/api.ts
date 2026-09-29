/**
 * 服务端 API 客户端 + 响应类型（与 apps/server 查询接口一一对应）
 */
const BASE = '/api'

export interface ErrorGroup {
  fingerprint: string
  type: string
  message: string
  count: number
  affectedSessions: number
  firstSeen: string
  lastSeen: string
  releases: string[]
  firstSeenRelease?: string
  isNewInRelease?: boolean
}

export interface Overview {
  since: string
  until: string
  totalEvents: number
  errorCount: number
  perfCount: number
  sessionCount: number
  topErrors: Array<{ fingerprint: string; type: string; message: string; count: number }>
}

export interface PerfQuantiles {
  metric: string
  count: number
  p50: number | null
  p75: number | null
  p95: number | null
}

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

export interface ErrorDetail {
  kind: 'error'
  type: string
  apikey: string
  release?: string
  sessionId: string
  page: string
  viewId?: string
  device: Record<string, string>
  error?: {
    message: string
    name?: string
    level?: string
    fingerprint: string
    componentName?: string
    stackFrames: Array<{
      url?: string | null
      func?: string | null
      line?: number | null
      column?: number | null
    }>
    http?: { method?: string; url?: string; status?: number; elapsedTime?: number }
  }
  breadcrumbs?: Array<{ type: string; data?: unknown; level?: string; time?: number }>
  symbolicatedStack?: SymbolicatedFrame[]
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return (await res.json()) as T
}

export const api = {
  overview: (sinceMinutes: number) => getJson<Overview>(`/overview?sinceMinutes=${sinceMinutes}`),
  errors: (limit = 50, release?: string) =>
    getJson<ErrorGroup[]>(
      `/errors?limit=${limit}${release ? `&release=${encodeURIComponent(release)}` : ''}`
    ),
  errorDetail: (fingerprint: string) =>
    getJson<ErrorDetail>(`/errors/${encodeURIComponent(fingerprint)}`),
  performance: (metric: string, sinceMinutes: number) =>
    getJson<PerfQuantiles>(
      `/performance?metric=${encodeURIComponent(metric)}&sinceMinutes=${sinceMinutes}`
    ),
}
