/**
 * 看板壳：tab 切换四个视图 + 10s 自动刷新 + 错误详情下钻
 */
import { useEffect, useState } from 'react'
import { OverviewView } from './views/OverviewView'
import { ErrorsView } from './views/ErrorsView'
import { ErrorDetailView } from './views/ErrorDetailView'
import { PerformanceView } from './views/PerformanceView'

type Tab = 'overview' | 'errors' | 'performance'

export default function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [refreshKey, setRefreshKey] = useState(0)
  const [fingerprint, setFingerprint] = useState<string | null>(null)

  // 10s 自动刷新（概览/性能视图消费 refreshKey；详情页不刷避免打断阅读）
  useEffect(() => {
    if (tab === 'errors' && fingerprint) return
    const timer = setInterval(() => setRefreshKey((k) => k + 1), 10_000)
    return () => clearInterval(timer)
  }, [tab, fingerprint])

  const openDetail = (fp: string): void => {
    setFingerprint(fp)
    setTab('errors')
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Simple Monitor</h1>
        <nav className="tabs">
          {(
            [
              ['overview', '概览'],
              ['errors', '错误'],
              ['performance', '性能'],
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
        <span className="muted">10s 自动刷新 · {new Date().toLocaleTimeString()}</span>
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
      </main>
    </div>
  )
}
