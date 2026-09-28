import { getAppId, isWxMiniEnv, variableTypeDetection } from '@simple-monitor/utils'
import { ErrorTypes, EventTypes, ReportDataType } from '@simple-monitor/types'

/**
 * generate error unique Id
 *
 * 指纹取舍（总纲 §五规格 1）：SDK 侧为 message 级 hash——目的是流量去重防刷屏，
 * 不含堆栈/行列；分析精度由服务端 fingerprint（含首帧位置）负责。两层分工。
 *
 * @param data 错误上报数据
 * @param apikey 项目标识（隔离不同项目的去重计数）
 * @param maxDuplicateCount 同指纹最大上报次数，超过返回 null（调用方跳过上报）
 */
export function createErrorId(
  data: ReportDataType,
  apikey: string,
  maxDuplicateCount = 2
): number | null {
  let idStr: string
  const errorType = data.type ?? ErrorTypes.UNKNOWN
  switch (errorType) {
    case ErrorTypes.FETCH_ERROR:
      idStr =
        (data.type ?? '') +
        (data.request?.method ?? '') +
        (data.response?.status ?? '') +
        getRealPath(data.request?.url ?? '') +
        apikey
      break
    case ErrorTypes.JAVASCRIPT_ERROR:
    case ErrorTypes.VUE_ERROR:
    case ErrorTypes.REACT_ERROR:
      idStr = (data.type ?? '') + (data.name ?? '') + (data.message ?? '') + apikey
      break
    case ErrorTypes.LOG_ERROR:
      idStr = (data.customTag ?? '') + (data.type ?? '') + (data.name ?? '') + apikey
      break
    case ErrorTypes.PROMISE_ERROR:
      idStr = generatePromiseErrorId(data, apikey)
      break
    default:
      idStr = (data.type ?? '') + (data.message ?? '') + apikey
      break
  }
  const id = hashCode(idStr)
  if (getDedupCount(id) >= maxDuplicateCount) {
    return null
  }
  incDedupCount(id)

  return id
}

/**
 * 会话级错误去重的存储抽象。
 *
 * 分两层：
 *  - 内存 cache：命中时不读存储，避免每次上报都走同步 IO。
 *  - sessionStorage：刷新后仍保留，关闭标签页自动清空——语义对齐「同一会话内的去重」。
 *
 * 去重状态天然属于「标签页/会话」而非 SDK 实例，因此保留模块级实现（与 ADR-1 不冲突：
 * 多实例共享同一会话的去重预算正是预期行为）。跨标签页不共享是 sessionStorage 的特性，
 * 真正跨设备/长期的去重是服务端职责。
 *
 * 存储失败（隐私模式、配额超限）时降级为纯内存，退化后不劣于原实现。
 */
const DEDUP_KEY_PREFIX = 'monitor:dedup:'
const dedupCache: Record<string, number> = {}

/** 框架无关地拿到 sessionStorage（core 的 tsconfig 不引 DOM lib） */
interface SessionStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
  readonly length: number
}

function safeSessionStorage(): SessionStorageLike | null {
  try {
    const storage = getGlobalThis()?.sessionStorage
    return storage ? (storage as SessionStorageLike) : null
  } catch {
    // 访问 sessionStorage 本身在某些浏览器会抛（如禁用 cookie）
    return null
  }
}

/** SSR 安全的全局对象获取（core 不引 DOM lib） */
function getGlobalThis(): any {
  return typeof globalThis !== 'undefined' ? globalThis : undefined
}

/** 读取某条错误在本会话内已上报次数（命中内存则不读存储）。 */
function getDedupCount(id: number): number {
  const key = DEDUP_KEY_PREFIX + id
  if (key in dedupCache) return dedupCache[key]
  let count = 0
  const storage = safeSessionStorage()
  if (storage) {
    try {
      const raw = storage.getItem(key)
      count = raw ? Number(raw) : 0
    } catch {
      count = 0
    }
  }
  dedupCache[key] = count
  return count
}

/** 计数 +1 并持久化（存储失败则只更新内存）。 */
function incDedupCount(id: number): void {
  const key = DEDUP_KEY_PREFIX + id
  const next = (dedupCache[key] ?? 0) + 1
  dedupCache[key] = next
  const storage = safeSessionStorage()
  if (storage) {
    try {
      storage.setItem(key, String(next))
    } catch {
      // 隐私模式或配额超限：仅内存计数，退化为进程内去重
    }
  }
}

/** 清空去重状态（仅测试与重置场景使用）。 */
export function clearDedup(): void {
  for (const key of Object.keys(dedupCache)) {
    delete dedupCache[key]
  }
  const storage = safeSessionStorage()
  if (!storage) return
  try {
    for (let i = storage.length - 1; i >= 0; i--) {
      const k = storage.key(i)
      if (k && k.startsWith(DEDUP_KEY_PREFIX)) storage.removeItem(k)
    }
  } catch {
    // 存储不可用就跳过
  }
}

function generatePromiseErrorId(data: ReportDataType, apikey: string): string {
  const locationUrl = getRealPath(data.url ?? '')
  if (data.name === EventTypes.UNHANDLEDREJECTION) {
    return (data.type ?? '') + objectOrder(data.message) + apikey
  }
  return (data.type ?? '') + (data.name ?? '') + objectOrder(data.message) + locationUrl
}

function objectOrder(reason: any): string {
  const sortFn = (obj: any): any => {
    return Object.keys(obj)
      .sort()
      .reduce(
        (total: Record<string, any>, key: string) => {
          if (variableTypeDetection.isObject(obj[key])) {
            total[key] = sortFn(obj[key])
          } else {
            total[key] = obj[key]
          }
          return total
        },
        {} as Record<string, any>
      )
  }
  try {
    if (/\{.*\}/.test(reason)) {
      let obj = JSON.parse(reason)
      obj = sortFn(obj)
      return JSON.stringify(obj)
    }
  } catch (error) {
    return String(reason)
  }
  return String(reason)
}

/**
 * http://.../project?id=1#a => http://.../project
 * http://.../id/123 => http://.../id/{param}
 * http://.../api/123/user/456 => http://.../api/{param}/user/{param}
 *
 * 归一化规则：去掉 query/hash，把任意位置的「纯数字段」换成 {param}。
 * 只匹配整段为数字的路径段，不误伤版本号（/v2/）或字母混合段。
 */
export function getRealPath(url: string): string {
  return url
    .replace(/[?#].*$/, '')
    .replace(/\/\d+(?=\/|$)/g, '/{param}')
}

/**
 * 小程序环境下页面 origin 归一为 appId（wx 采集包实装时启用）。
 */
export function getRealPageOrigin(url: string): string {
  if (isWxMiniEnv) {
    return getAppId()
  }
  return getRealPath(url)
}

export function hashCode(str: string): number {
  let hash = 0
  if (str.length == 0) return hash
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return hash
}
