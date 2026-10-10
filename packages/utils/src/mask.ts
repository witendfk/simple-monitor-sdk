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
 * 出口兜底：信封组装时嵌套结构整体过 maskDeep（core/envelope、core/behaviorEnvelope），
 * 覆盖上述入口未触达的旁路（行为 props / PV / 成功 API URL / perf detail）。
 */

import { interceptStr } from './string'

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
 * 剥离 URL 的 query 与 hash（绝对 URL 保留 origin，相对路径保留 pathname）。
 * query 是 token/用户标识的常见藏身处，路径本体保留路由定位价值。
 * 与 sanitizePageUrl 同一立场，但不做 URL 解析（纯字符串截断，相对/绝对/残缺形态统一处理）。
 * 页面/成功请求明细的 URL 策略；error.http.url 另有「遮蔽凭证、保留 query」的独立设计（core/envelope）。
 */
export function stripUrlQuery(url: string): string {
  if (!url || typeof url !== 'string') return url
  const hashIdx = url.indexOf('#')
  const noHash = hashIdx === -1 ? url : url.slice(0, hashIdx)
  const queryIdx = noHash.indexOf('?')
  return queryIdx === -1 ? noHash : noHash.slice(0, queryIdx)
}

export interface MaskDeepOptions {
  /** 单字符串截断上限（先 mask 后截断——截断边界不会漏出半段凭证） */
  maxString?: number
  /** 递归深度上限（防超深嵌套） */
  maxDepth?: number
  /** 数组元素数上限 */
  maxArray?: number
  /** 对象键数上限 */
  maxKeys?: number
}

const MASK_DEEP_DEFAULTS: Required<MaskDeepOptions> = {
  maxString: 2048,
  maxDepth: 8,
  maxArray: 200,
  maxKeys: 64,
}

/**
 * 结构性标识键：值是 ID / 指纹 / 追踪号，**不做内容脱敏**——
 * 数字串规则会把哈希里偶现的长数字段咬成 [card]，traceId 就再也链不回去了。
 */
const STRUCTURAL_ID_KEYS = new Set([
  'errorId',
  'traceId',
  'spanId',
  'sessionId',
  'trackerId',
  'viewId',
  'apiKey',
  'fingerprint',
])

/**
 * 敏感值键：键名本身即凭证语义，命中则**整值遮蔽**——
 * 值侧模式（token=/Bearer/eyJ）只认文本特征，`{ pwd: 'hunter2' }` 这类
 * 无数字、无凭证前缀的裸值只能靠键名识别（宁可遮错，不可泄露）。
 */
const SENSITIVE_VALUE_KEYS =
  /^(password|passwd|pwd|pass|token|secret|authorization|auth|credential)$/i

/**
 * 嵌套结构深度脱敏（信封出口兜底）：递归遍历对象/数组，
 *  - 字符串：过 mask；标识键原样保留；
 *  - 数值/布尔：原样保留（13 位时间戳曾被数字串规则误伤成 [card] 的教训）；
 *  - 先 mask 后截断，超限字符串截断到 maxString。
 *
 * 幂等：对已脱敏的结构重复执行结果不变（[phone] 不含凭证/长数字段），
 * 入口三件套与出口兜底双层调用安全。URL 字段不在此处理——剥 query 还是
 * 遮蔽凭证是各载荷自己的设计决策（页面/成功请求剥 query，error.http 保 query）。
 * 返回新容器，不改写入参（缓冲中的载荷对象可能被重复用于重建信封）。
 */
export function maskDeep(value: unknown, options: MaskDeepOptions = {}): unknown {
  const opts = { ...MASK_DEEP_DEFAULTS, ...options }
  return walk(value, opts, undefined, 0)
}

function walk(
  value: unknown,
  opts: Required<MaskDeepOptions>,
  key: string | undefined,
  depth: number
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (key && STRUCTURAL_ID_KEYS.has(key)) return value
    if (key && SENSITIVE_VALUE_KEYS.test(key)) return '[credential]'
    return interceptStr(mask(value), opts.maxString)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= opts.maxDepth) return '[truncated]'
  if (Array.isArray(value)) {
    return value.slice(0, opts.maxArray).map((v) => walk(v, opts, undefined, depth + 1))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, opts.maxKeys)) {
      out[k] = walk(v, opts, k, depth + 1)
    }
    return out
  }
  return interceptStr(mask(String(value)), opts.maxString)
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
