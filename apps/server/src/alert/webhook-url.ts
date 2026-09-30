/**
 * webhook SSRF 防护（总纲 §3.7 P0-6）：告警 webhook 是服务端主动外呼，
 * URL 可写即内网探测/写通道——协议白名单 + 私网/环回/链路本地默认拒绝。
 * 本地演示经 WEBHOOK_ALLOW_PRIVATE=1 显式放开（config.webhookAllowPrivate）。
 */
const PRIVATE_V4 = /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|172\.(1[6-9]|2\d|3[01])\.)/

export function isSafeWebhookUrl(raw: string, allowPrivate = false): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (allowPrivate) return true
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (host === '::1') return false
  return !PRIVATE_V4.test(host)
}
