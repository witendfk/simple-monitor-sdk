/**
 * 登录视图（M7.5 P3 · 视觉稿 v2 定稿：apps/dashboard/design/login-v1.html）
 * 暗色分屏——左品牌叙事（NightOwl）/ 右账号密码表单。
 * 账号 + 密码 → /auth/login 换 HttpOnly 会话 cookie（7 天）。
 */
import { useState } from 'react'
import { authApi } from '../api'

const EyeIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)
const UserIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
)
const LockIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)
const ShieldIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  </svg>
)
const AlertIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" x2="12" y1="8" y2="12" />
    <line x1="12" x2="12.01" y1="16" y2="16" />
  </svg>
)
const PulseIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </svg>
)
const ClockIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </svg>
)

export function LoginView({ onSuccess }: { onSuccess: () => void }) {
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      await authApi.login(account, password)
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-shell">
      {/* 左：品牌叙事区 */}
      <div className="brand-pane">
        <div className="brand-row">
          <div className="brand-logo">
            <EyeIcon />
          </div>
          <div className="brand-name">NightOwl</div>
        </div>
        <div className="brand-hero">
          <h2>
            看到用户真实体验的
            <br />
            <span className="dim">每一毫秒与每一次报错</span>
          </h2>
          <div className="brand-points">
            <div className="brand-point">
              <span className="ico">
                <PulseIcon />
              </span>
              <span>错误自动聚合与 SourceMap 符号化，堆栈直指源码行</span>
            </div>
            <div className="brand-point">
              <span className="ico">
                <ShieldIcon />
              </span>
              <span>零依赖自建采集端，数据完全留在你的基础设施内</span>
            </div>
            <div className="brand-point">
              <span className="ico">
                <ClockIcon />
              </span>
              <span>Web Vitals 对齐官方口径，性能分位与告警开箱即用</span>
            </div>
          </div>
        </div>
        <div className="brand-footer">
          <span>© 2026 NightOwl</span>
          <span className="dot-sep">·</span>
          <span>自托管 · 数据不出内网</span>
        </div>
      </div>

      {/* 右：表单区 */}
      <div className="form-pane">
        <form className={'login-col' + (error ? ' is-error' : '')} onSubmit={(e) => void submit(e)}>
          <h1 className="login-title">登录管理台</h1>
          <p className="login-sub">输入管理员账号，查看项目监控数据</p>
          <div className="field">
            <label htmlFor="login-account">账号</label>
            <div className="input-wrap">
              <span className="lead-icon">
                <UserIcon />
              </span>
              <input
                id="login-account"
                type="text"
                placeholder="admin"
                autoComplete="username"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="login-password">密码</label>
            <div className="input-wrap">
              <span className="lead-icon">
                <LockIcon />
              </span>
              <input
                id="login-password"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>
          {error && (
            <div className="form-error">
              <AlertIcon />
              账号或密码错误（连续失败 5 次将锁定 15 分钟）
            </div>
          )}
          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting ? '登录中…' : '登 录'}
          </button>
          <p className="form-hint">会话有效期 7 天 · SourceMap CLI 请使用项目密钥</p>
        </form>
      </div>
    </div>
  )
}
