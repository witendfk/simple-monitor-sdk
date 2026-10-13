/**
 * 登录视图（M7.5 P3 权限分离）：邮箱 + 密码 → /auth/login 换 HttpOnly 会话 cookie。
 * 极简形态（P5 看板对齐时统一视觉），功能优先：错误展示 + 提交态防连点。
 */
import { useState } from 'react'
import { authApi } from '../api'

export function LoginView({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      await authApi.login(email, password)
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <h1>Simple Monitor</h1>
        <p className="muted">管理登录（会话 7 天有效）</p>
        <input
          type="email"
          placeholder="邮箱"
          value={email}
          autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={submitting}>
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
