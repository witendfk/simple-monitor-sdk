/**
 * 错误详情：符号化堆栈（原始源码位置高亮）+ 面包屑时间线
 */
import { useEffect, useState } from 'react'
import { api, type ErrorDetail } from '../api'

export function ErrorDetailView({
  fingerprint,
  onBack,
}: {
  fingerprint: string
  onBack: () => void
}) {
  const [detail, setDetail] = useState<ErrorDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .errorDetail(fingerprint)
      .then(setDetail)
      .catch((e: Error) => setError(e.message))
  }, [fingerprint])

  if (error) return <p className="error-text">加载失败：{error}</p>
  if (!detail) return <p>加载中…</p>

  return (
    <section>
      <button className="button" onClick={onBack}>
        ← 返回列表
      </button>
      <h3>
        <code>{detail.type}</code>
        {detail.error?.componentName && (
          <span className="muted"> @{detail.error.componentName}</span>
        )}
      </h3>
      <p className="mono error-text">{detail.error?.message}</p>
      <p className="muted">
        页面 {detail.page || '—'}
        {detail.viewId && ` · 视图 ${detail.viewId}`}
        {detail.release && ` · 发版 ${detail.release}`}
        {` · 会话 ${detail.sessionId.slice(0, 8)}`}
      </p>

      <h4>堆栈{detail.symbolicatedStack?.some((f) => f.original) && '（已符号化 ✅）'}</h4>
      <ol className="stack-list">
        {(
          detail.symbolicatedStack ??
          (detail.error?.stackFrames ?? []).map((f) => ({ ...f, original: null as null }))
        ).map((f, i) => (
          <li key={i} className="stack-frame">
            <div className="mono">
              {f.func ?? '(anonymous)'} @ {f.url ?? '?'}:{f.line ?? '?'}:{f.column ?? '?'}
            </div>
            {f.original && (
              <div className="mono original-frame">
                ↳ {f.original.source}:{f.original.line ?? '?'}:{f.original.column ?? '?'}
                {f.original.name && ` (${f.original.name})`}
              </div>
            )}
          </li>
        ))}
      </ol>

      <h4>面包屑（出错前行为）</h4>
      {(detail.breadcrumbs?.length ?? 0) === 0 && <p className="muted">无</p>}
      <ul className="crumb-list">
        {(detail.breadcrumbs ?? []).map((b, i) => (
          <li key={i}>
            <span className="muted">{b.time ? new Date(b.time).toLocaleTimeString() : '—'}</span>{' '}
            <code>{b.type}</code>{' '}
            <span className="mono">
              {truncate(typeof b.data === 'string' ? b.data : JSON.stringify(b.data), 120)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function truncate(text: string | undefined, max: number): string {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}
