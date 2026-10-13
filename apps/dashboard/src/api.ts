/**
 * 服务端 API 客户端 + 响应类型（与 apps/server 查询接口一一对应）
 */
const BASE = '/api'
/**
 * 看板访问身份（M7.5 P3 权限分离）：服务端会话 cookie（HttpOnly，登录后自动携带）。
 * 管理密钥不进构建产物——凭据只存在于用户输入 → /auth/login 换取会话。
 * 401 统一抛 AuthRequiredError，App 壳捕获后展示登录视图。
 */
export class AuthRequiredError extends Error {
  constructor() {
    super('authentication required')
    this.name = 'AuthRequiredError'
  }
}

function handleAuth(res: Response): Response {
  if (res.status === 401) {
    // 全局广播：会话过期/未登录——App 壳监听后回落登录视图（视图层无需各自处理）
    window.dispatchEvent(new CustomEvent('sm:auth-lost'))
    throw new AuthRequiredError()
  }
  return res
}

export const authApi = {
  login: async (email: string, password: string): Promise<void> => {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) throw new Error('邮箱或密码错误')
  },
  logout: (): Promise<void> => fetch('/auth/logout', { method: 'POST' }).then(() => undefined),
  me: async (): Promise<{ email: string; apikey: string }> => {
    const res = await fetch(`${BASE.replace('/api', '')}/auth/me`).then(handleAuth)
    return (await res.json()) as { email: string; apikey: string }
  },
}

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
  const res = handleAuth(await fetch(`${BASE}${path}`, { credentials: 'include' }))
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
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    })
      .then(handleAuth)
      .then(async (res) => {
        if (!res.ok) throw new Error(`create failed: ${res.status}`)
        return (await res.json()) as AlertRule
      }),
  remove: (id: string) =>
    fetch(`${BASE}/alert-rules/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    })
      .then(handleAuth)
      .then((res) => {
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
