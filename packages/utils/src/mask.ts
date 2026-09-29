/**
 * 隐私脱敏（M1 收尾批次，总纲 §3.4 / §4.1）
 *
 * 设计立场：**脱敏是隐私底线，默认全开且全局统一**——不随 client 实例配置变化，
 * 避免某个实例漏配导致泄露。业务确需原始数据（极少见）才显式关闭。
 * 策略取向：宁可遮错，不可泄露（粗匹配可接受）。
 *
 * 接入点（三入口）：
 *  1. DOM 序列化 innerText（utils/htmlElementAsString）
 *  2. console args（core/handleConsole）
 *  3. HTTP 请求/响应体（browser/replace）
 */

/** 开关默认开启；client.init 时按 enablePrivacyMask 显式同步 */
let enabled = true

export function setPrivacyMaskEnabled(value: boolean): void {
  enabled = value
}

export function isPrivacyMaskEnabled(): boolean {
  return enabled
}

/**
 * 凭证模式（先于数字串执行，值里可能含数字）。
 */
const CREDENTIAL_PATTERN =
  /(?:Bearer\s+|token\s*[=:]\s*|password\s*[=:]\s*|pwd\s*[=:]\s*)[\w.\-/+=]+|eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*/gi

/**
 * 长数字串整体捕获（>=10 位）再分类——避免多个定长正则交叠执行
 * 把 18 位身份证咬出「110101[phone]8」这类残片（顺序敏感正则的经典错误）。
 * 分类语义 best-effort：手机号精确，其余一律按身份证/卡号遮蔽（宁可遮错不可泄露）。
 */
const DIGIT_RUN_PATTERN = /\d{10,}[Xx]?/g

function maskDigitRun(run: string): string {
  if (run.length === 11 && /^1[3-9]/.test(run)) return '[phone]'
  if (/^\d{17}[\dXx]$/.test(run)) return '[id]'
  return '[card]'
}

/**
 * 对文本做敏感信息遮蔽；非字符串或未开启时原样返回。
 */
export function mask(text: string): string {
  if (!enabled || !text || typeof text !== 'string') return text
  return text.replace(CREDENTIAL_PATTERN, '[credential]').replace(DIGIT_RUN_PATTERN, maskDigitRun)
}

/**
 * 页面 URL 脱敏（第四隐私入口）：只保留 origin + pathname，剥离 query 与 hash。
 * query 是 token/用户标识的常见藏身处（`?token=...&uid=...`）；hash 路由的页面
 * 身份由 viewId 字段承载（采集时刻归一化），此处不再重复。
 * 非法/相对 URL 降级为 mask 遮蔽（至少保证凭证不外泄）。
 */
export function sanitizePageUrl(url: string): string {
  if (!url || typeof url !== 'string') return url
  try {
    const u = new URL(url)
    return u.origin + u.pathname
  } catch {
    return mask(url)
  }
}
