/**
 * Simple Monitor SDK - Browser Platform Adapter
 *
 * 浏览器端采集：包装/监听原生 API（error / 资源 / ...），
 * 经 client 的事件总线 → transform → transportData 上报。
 *
 * 本包不直接面向业务使用，由 @simple-monitor/web 聚合包转出。
 */

import type { InitOptions } from '@simple-monitor/types'
import { logger } from '@simple-monitor/utils'
import { getDefaultMonitorClient } from '@simple-monitor/core'
import type { MonitorClient } from '@simple-monitor/core'
import { setupReplace } from './setupReplace'

export { setupReplace } from './setupReplace'

/**
 * 页面级 instrumentation 单例（ADR-1 的边界说明）：
 *
 * 原生 API 只能被有效包装一次——原型上的包装函数闭包持有装载它的那个 client，
 * 第二次包装只会叠层不会换绑。因此 browser 包显式声明「一个页面一个 client」：
 *  - 首个成功 init 的 client 独占本页 instrumentation；
 *  - 重复 init 同一 client：幂等跳过（返回 true）；
 *  - 换 client 再 init：告警并忽略（返回 true，不影响已装的采集）。
 * 多实例监控（同页双 client）不支持——那是多实例类化的边界，如实声明而非静默错绑。
 */
let instrumentedClient: MonitorClient | null = null

/** 门面级防重入标记（保留：web 门面用它阻止 WebVitals 重复构造） */
const INIT_FLAG = '__Monitor__init__'
export { INIT_FLAG }

/**
 * 初始化浏览器端监控。
 *
 * - init 失败（缺 dsn/apikey）返回 false 且不装载任何采集器（可修正配置后重试）。
 * - 成功后本页 instrumentation 绑定该 client；重复/换 client 调用见上方单例说明。
 *
 * @param options dsn 与 apikey 必填
 * @param client 目标实例，缺省为默认全局 client
 * @returns 是否已就绪（首次成功或已初始化均为 true）
 */
export function init(
  options: InitOptions = {},
  client: MonitorClient = getDefaultMonitorClient()
): boolean {
  // 非浏览器环境（SSR/Node）：无 window 可挂载，明确拒绝而非装载后崩溃
  if (typeof window === 'undefined') {
    logger.warn('browser SDK 仅支持浏览器环境（未检测到 window），init 已跳过')
    return false
  }
  if (instrumentedClient) {
    if (instrumentedClient !== client) {
      logger.warn(
        'browser 监控已绑定另一个 MonitorClient 实例（一个页面仅支持一个 client），本次 init 已忽略'
      )
    }
    return true
  }
  if (!client.init(options)) return false
  instrumentedClient = client
  setupReplace(client)
  return true
}

/** 测试专用：解除页面 instrumentation 绑定（不还原原生补丁——jsdom 每文件独立环境） */
export function __resetInstrumentationForTest(): void {
  instrumentedClient = null
}

/**
 * 主动上报一条日志/错误（手动 API，对应 README 的 log）。
 * 实现位于 core（extractErrorStack + breadcrumb + transportData.send），
 * 此处转出，避免在 browser 重新声明空函数遮蔽 core 的真实现。
 */
export { log } from '@simple-monitor/core'
