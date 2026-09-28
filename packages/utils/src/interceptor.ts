/**
 * API 拦截器工具
 *
 * 提供拦截/替换原生方法为自定义实现的功能。
 * 用于监控目的 - 包装原生 API 以捕获事件。
 *
 * @module interceptor
 */

/**
 * 通用对象类型，用于灵活的数据结构
 */
export type AnyObject = Record<string, any>

/**
 * 被拦截函数的回调类型
 * 接收原始函数并返回包装后的函数
 */
export type InterceptorCallback<T = any> = (original: T) => T

export function replaceOld(
  source: AnyObject,
  name: string,
  replacement: InterceptorCallback,
  isForced = false
): void {
  // 源对象验证
  if (source === undefined || source === null) {
    return
  }

  // 检查属性是否存在或强制替换
  if (name in source || isForced) {
    // 保存原始函数
    const original = source[name]

    // 防重复包装：已被本 SDK 包装过的方法直接跳过，
    // 避免 HMR/StrictMode/多次 init 导致同一方法被层层套娃
    // （每多一层包装，triggerHandlers 就多触发一次，且性能损耗累积）
    if (original && (original as any).__monitor_wrapped) {
      return
    }

    // 创建包装函数
    const wrapped = replacement(original)

    // 如果结果是有效函数则替换
    if (typeof wrapped === 'function') {
      ;(wrapped as any).__monitor_wrapped = true
      source[name] = wrapped
    }
  }
}

/**
 * 将先前替换的方法恢复为原始实现。
 *
 * @param source - 包含方法的对象
 * @param name - 要恢复的方法名称
 * @param original - 要恢复的原始函数
 */
export function restoreMethod(source: AnyObject, name: string, original: any): void {
  if (source && name && typeof original === 'function') {
    source[name] = original
  }
}

/**
 * 检查方法是否已被替换/包装。
 *
 * @param source - 包含方法的对象
 * @param name - 要检查的方法名称
 * @returns 如果方法存在且是函数则返回 true
 */
export function isMethodReplaced(source: AnyObject, name: string): boolean {
  return !!(source && name && typeof source[name] === 'function')
}

/**
 * 全局跟踪器，用于所有被拦截的方法以支持恢复。
 * 映射关系：sourceObject_propertyName -> originalFunction
 */
const interceptRegistry = new WeakMap<AnyObject, Map<string, any>>()

/**
 * 替换方法并注册以便后续恢复。
 *
 * @param source - 包含方法的对象
 * @param name - 方法名称
 * @param replacement - 包装回调函数
 * @param isForced - 是否强制替换
 * @returns 用于恢复原始方法的函数
 */
export function replaceTrackable(
  source: AnyObject,
  name: string,
  replacement: InterceptorCallback,
  isForced = false
): () => void {
  // 获取或创建此源的注册表
  let sourceRegistry = interceptRegistry.get(source)
  if (!sourceRegistry) {
    sourceRegistry = new Map()
    interceptRegistry.set(source, sourceRegistry)
  }

  // 如果尚未保存则保存原始函数
  if (!sourceRegistry.has(name)) {
    sourceRegistry.set(name, source[name])
  }

  const original = sourceRegistry.get(name)

  // 执行替换
  replaceOld(source, name, replacement, isForced)

  // 返回恢复函数
  return () => {
    restoreMethod(source, name, original)
  }
}
