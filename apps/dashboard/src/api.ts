/**
 * 服务端 API 客户端 + 响应类型（与 apps/server 查询接口一一对应）
 */
const BASE = '/api'
/** 看板访问身份：/api/** 经 x-api-key 鉴权（与 SDK 接入同源，构建时可覆盖） */
const API_KEY: string = (import.meta.env.VITE_API_KEY as string | undefined) ?? 'demo-key'

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
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-api-key': API_KEY } })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return (await res.json()) as T
}

export interface AlertRule {
  id: string
  apikey: string
  type: 'error_spike' | 'perf_threshold'
  name: string
  webhookUrl: string
  cooldownMinutes: number
  enabled: boolean
  config: Record<string, unknown>
}

export interface AlertFire {
  id: string
  ruleId: string
  ruleName: string
  apikey: string
  firedAt: string
  message: string
  context: Record<string, unknown>
}

export const alertApi = {
  list: () => getJson<AlertRule[]>('/alert-rules'),
  create: (rule: Omit<AlertRule, 'id'>) =>
    fetch(`${BASE}/alert-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(rule),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`create failed: ${res.status}`)
      return (await res.json()) as AlertRule
    }),
  remove: (id: string) =>
    fetch(`${BASE}/alert-rules/${id}`, {
      method: 'DELETE',
      headers: { 'x-api-key': API_KEY },
    }).then((res) => {
      if (!res.ok) throw new Error(`delete failed: ${res.status}`)
    }),
  fires: (limit = 50) => getJson<AlertFire[]>(`/alert-fires?limit=${limit}`),
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
