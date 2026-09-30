/**
 * webhook 连接时校验（总纲 §3.8 P0 第二道）：字面值过滤挡不住「公网域名
 * 解析到私网」（DNS 重绑定）。创建时只做静态判定（webhook-url.ts），发送前
 * 对域名做 DNS 解析并复核解析结果——解析即校验，投递紧随其后，缩短 TOCTOU
 * 窗口；彻底的连接级拦截（socket dial 校验）不在本层（需要自定义 dispatcher）。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isHostAllowedLiteral } from './webhook-url'

/** 发送前校验目标 URL：IP 字面量直接判定；域名解析后按解析结果判定 */
export async function isWebhookUrlConnectAllowed(rawUrl: string): Promise<boolean> {
  let hostname: string
  try {
    hostname = new URL(rawUrl).hostname
  } catch {
    return false
  }
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) return isHostAllowedLiteral(hostname)
  try {
    const { address } = await lookup(hostname, { all: false })
    return isHostAllowedLiteral(address)
  } catch {
    return false // 解析失败按拒绝处理（宁可误拒）
  }
}
