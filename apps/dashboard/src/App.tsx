/**
 * 应用壳（M7.5 P5a · 视觉稿定稿）：Finder 式侧栏 + 顶栏。
 * 登录态门控：mount 时 /auth/me 校验会话；任意 401（sm:auth-lost 事件）回落登录视图。
 * 菜单即终局形态：已实现页可点，规划中项诚实禁用（不提供假页面）。
 * 错误详情为异常分析的下钻（不走菜单，fingerprint 驱动）。
 */
import { useEffect, useState } from 'react'
import { authApi } from './api'
import { LoginView } from './components/LoginView'
import { OverviewView } from './views/OverviewView'
import { ErrorsView } from './views/ErrorsView'
import { ErrorDetailView } from './views/ErrorDetailView'
import { PerformanceView } from './views/PerformanceView'
import { AlertsView } from './views/AlertsView'

type Tab = 'overview' | 'errors' | 'performance' | 'alerts'

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function NavIcon({ kind }: { kind: string }): JSX.Element {
  const paths: Record<string, JSX.Element> = {
    grid: (
      <>
        <rect width="7" height="9" x="3" y="3" rx="1" />
        <rect width="7" height="5" x="14" y="3" rx="1" />
        <rect width="7" height="9" x="14" y="12" rx="1" />
        <rect width="7" height="5" x="3" y="16" rx="1" />
      </>
    ),
    alert: (
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" x2="12" y1="8" y2="12" />
        <line x1="12" x2="12.01" y1="16" y2="16" />
      </>
    ),
    pulse: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
    bell: (
      <>
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </>
    ),
    radio: (
      <>
        <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
        <circle cx="12" cy="12" r="2" />
        <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    box: <path d="M12 2v13" />,
    file: (
      <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 1.38V4a2 2 0 0 1 2-2" />
    ),
    click: <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />,
    funnel: <path d="M3 3h18l-7 8v7l-4 3v-10Z" />,
    repeat: (
      <>
        <path d="m17 2 4 4-4 4" />
        <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path d="m7 22-4-4 4-4" />
        <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      </>
    ),
    crosshair: (
      <>
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="2" />
      </>
    ),
    upload: <path d="M12 2v13" />,
    key: (
      <>
        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </>
    ),
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />,
    bot: (
      <>
        <path d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2" />
        <path d="M20 14h2" />
        <path d="M15 13v2" />
        <path d="M9 13v2" />
      </>
    ),
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
      {paths[kind] ?? null}
    </svg>
  )
}

const PLANNED: Array<[string, string, string, string]> = [
  ['realtime', '实时监控', '候选池（SSE）', 'radio'],
  ['api', 'API 监控', 'M8', 'pulse'],
  ['visits', '页面访问', 'M8', 'eye'],
  ['resources', '静态资源', 'M8', 'box'],
  ['logs', '日志查询', '规划中', 'file'],
  ['events', '事件分析', 'M9', 'click'],
  ['funnel', '转化漏斗', 'M9', 'funnel'],
  ['retention', '用户留存', 'M9', 'repeat'],
  ['exposure', '曝光分析', 'M9', 'crosshair'],
  ['sourcemaps', 'Source Map', '规划中', 'upload'],
  ['appkeys', '应用与密钥', '规划中', 'key'],
  ['channels', '通知渠道', '候选池', 'radio'],
  ['members', '成员与权限', '剪裁线', 'shield'],
  ['ai', 'AI 诊断', 'M10', 'bot'],
]

export default function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [refreshKey, setRefreshKey] = useState(0)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  // 登录态：mount 时 /auth/me 校验会话；任意 401（含会话过期）回落登录视图
  const [authState, setAuthState] = useState<'checking' | 'anon' | 'authed'>('checking')
  const [me, setMe] = useState<{ account: string } | null>(null)

  useEffect(() => {
    authApi
      .me()
      .then((info) => {
        setMe(info)
        setAuthState('authed')
      })
      .catch(() => setAuthState('anon'))
    // 会话过期（401 广播）统一回落登录
    const onLost = (): void => {
      setMe(null)
      setAuthState('anon')
    }
    window.addEventListener('sm:auth-lost', onLost)
    return () => window.removeEventListener('sm:auth-lost', onLost)
  }, [])

  const onAuthLost = (): void => {
    setMe(null)
    setAuthState('anon')
  }

  // 10s 自动刷新（概览/性能视图消费 refreshKey；详情页不刷避免打断阅读）
  useEffect(() => {
    if (tab === 'errors' && fingerprint) return
    const timer = setInterval(() => setRefreshKey((k) => k + 1), 10_000)
    return () => clearInterval(timer)
  }, [tab, fingerprint])

  if (authState === 'checking') {
    return <div className="login-wrap">会话校验中…</div>
  }
  if (authState === 'anon') {
    return (
      <LoginView
        onSuccess={() => {
          authApi
            .me()
            .then((info) => {
              setMe(info)
              setAuthState('authed')
              setRefreshKey((k) => k + 1)
            })
            .catch(() => setAuthState('anon'))
        }}
      />
    )
  }

  const openDetail = (fp: string): void => {
    setFingerprint(fp)
    setTab('errors')
  }

  const navBtn = (key: Tab, label: string, icon: string): JSX.Element => (
    <button
      key={key}
      className={`nav-item${tab === key ? ' active' : ''}`}
      onClick={() => {
        setTab(key)
        if (key !== 'errors') setFingerprint(null)
      }}
    >
      <NavIcon kind={icon} />
      {label}
    </button>
  )

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">
            <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
              <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <div className="name">NightOwl</div>
        </div>
        <div className="nav-group">
          <div className="nav-group-title">监控</div>
          {navBtn('overview', '数据总览', 'grid')}
          {navBtn('errors', '异常分析', 'alert')}
          {navBtn('performance', '页面性能', 'pulse')}
        </div>
        <div className="nav-group">
          <div className="nav-group-title">系统</div>
          {navBtn('alerts', '告警规则', 'bell')}
        </div>
        <div className="nav-group">
          <div className="nav-group-title">规划中</div>
          {PLANNED.map(([key, label, note, icon]) => (
            <button key={key} className="nav-item disabled" title={note}>
              <NavIcon kind={icon} />
              {label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <div className="side-footer">
          <div className="user-row">
            <div className="avatar">{(me?.account ?? '?').slice(0, 2)}</div>
            <div className="who">{me?.account ?? ''}</div>
          </div>
          <div className="version">NightOwl v0.3.0</div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <span className="chip">
            <span className="green-dot" />
            <b>demo-store</b>
          </span>
          <span className="chip">
            环境 <b>production</b>
          </span>
          <span className="chip">近 1 小时 ▾</span>
          <span className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>
            10s 自动刷新
          </span>
          <button
            className="link-btn"
            onClick={() => {
              void authApi.logout().then(onAuthLost)
            }}
          >
            退出
          </button>
        </div>

        <main className="content">
          {tab === 'overview' && <OverviewView refreshKey={refreshKey} />}
          {tab === 'errors' &&
            (fingerprint ? (
              <ErrorDetailView fingerprint={fingerprint} onBack={() => setFingerprint(null)} />
            ) : (
              <ErrorsView onOpen={openDetail} />
            ))}
          {tab === 'performance' && <PerformanceView refreshKey={refreshKey} />}
          {tab === 'alerts' && <AlertsView refreshKey={refreshKey} />}
        </main>
      </div>
    </div>
  )
}
