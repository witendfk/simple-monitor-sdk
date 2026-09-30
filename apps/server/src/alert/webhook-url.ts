/**
 * webhook SSRF 防护（总纲 §3.8 P0）：告警 webhook 是服务端主动外呼，
 * URL 可写即内网探测/写通道。本模块是第一道（URL 字面值）：
 *  - 协议白名单（仅 http/https）；
 *  - 主机名尾点剥离（`localhost.` 是等价 FQDN）与本地域名后缀拒绝；
 *  - IP 字面量（v4/v6/v4-mapped）经 net.BlockList 按私网/保留段判定
 *    ——Node 对 v4-mapped（::ffff:x.y.z.w 及其 hex 形态，URL 会统一规范化）
 *    自动按映射的 IPv4 判定（2026-09-30 实证）。
 * 第二道在连接时：域名经 DNS 解析后复核（webhook-net.ts），重定向逐跳复核。
 * 本地演示经 WEBHOOK_ALLOW_PRIVATE=1 显式放开（config.webhookAllowPrivate）。
 */
import { BlockList, isIP } from 'node:net'

const BLOCKED = new BlockList()
// IPv4：私网/环回/链路本地（元数据）/CGNAT/保留/组播
const V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]
V4_RANGES.forEach(([base, prefix]) => BLOCKED.addSubnet(base, prefix, 'ipv4'))
// IPv6：未指定/环回/ULA/链路本地/NAT64（64:ff9b:: 可转任意 v4 含私网，整段按私处理）
const V6_RANGES: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['64:ff9b::', 96],
]
V6_RANGES.forEach(([base, prefix]) => BLOCKED.addSubnet(base, prefix, 'ipv6'))

/** 本地域名后缀（不解析也必拒） */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal']

/**
 * 主机名（IP 字面量或域名）的静态判定：
 * IP 字面量按黑名单判定；域名只做本地名/后缀拒绝，IP 归属交给连接时 DNS 复核。
 */
export function isHostAllowedLiteral(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
  if (host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return false
  const kind = isIP(host)
  if (kind === 4) return !BLOCKED.check(host, 'ipv4')
  if (kind === 6) return !BLOCKED.check(host, 'ipv6')
  return true
}

export function isSafeWebhookUrl(raw: string, allowPrivate = false): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (allowPrivate) return true
  return isHostAllowedLiteral(u.hostname)
}
