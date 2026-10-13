/**
 * 看板壳：tab 切换四个视图 + 10s 自动刷新 + 错误详情下钻
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
    return <div className="login-wrap muted">会话校验中…</div>
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

  return (
    <div className="app">
      <header className="header">
        <h1>NightOwl</h1>
        <nav className="tabs">
          {(
            [
              ['overview', '概览'],
              ['errors', '错误'],
              ['performance', '性能'],
              ['alerts', '告警'],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              className={`tab${tab === key ? ' tab-active' : ''}`}
              onClick={() => {
                setTab(key)
                if (key !== 'errors') setFingerprint(null)
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <span className="muted">
          10s 自动刷新 · {new Date().toLocaleTimeString()} · {me?.account ?? ''}{' '}
          <button
            className="link-btn"
            onClick={() => {
              void authApi.logout().then(onAuthLost)
            }}
          >
            退出
          </button>
        </span>
      </header>

      <main>
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
  )
}
