/**
 * 错误列表：发版过滤 + 新错误回归标记，点击进入详情
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type ErrorGroup } from '../api'

export function ErrorsView({ onOpen }: { onOpen: (fingerprint: string) => void }) {
  const [groups, setGroups] = useState<ErrorGroup[]>([])
  const [release, setRelease] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .errors(50, release || undefined)
      .then(setGroups)
      .catch((e: Error) => setError(e.message))
  }, [release])

  useEffect(load, [load])

  return (
    <section>
      <div className="toolbar">
        <input
          className="input"
          placeholder="按 release 过滤（如 v1.2.3，可标记该发版新增/回归错误）"
          value={release}
          onChange={(e) => setRelease(e.target.value)}
        />
        <button className="button" onClick={load}>
          刷新
        </button>
      </div>
      {error && <p className="error-text">加载失败：{error}</p>}
      {!error && groups.length === 0 && <p>暂无错误数据（去 demo 页触发几个错误）</p>}
      {groups.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>类型</th>
              <th>消息</th>
              <th>次数</th>
              <th>会话</th>
              <th>发版</th>
              <th>最近发生</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.fingerprint} className="row-click" onClick={() => onOpen(g.fingerprint)}>
                <td>
                  <code>{g.type}</code>
                </td>
                <td className="msg-cell">{g.message}</td>
                <td>
                  <strong>{g.count}</strong>
                </td>
                <td>{g.affectedSessions}</td>
                <td>
                  {g.isNewInRelease === true && <span className="badge badge-new">新错误</span>}
                  <span className="muted">{g.releases.join(', ') || '—'}</span>
                </td>
                <td className="muted">{new Date(g.lastSeen).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
