/**
 * MonitorClient —— SDK 组合根（M1 核心重构，ADR-1）
 *
 * 一个 client = 一套完整的监控运行时：事件总线 + 静默开关 + 面包屑 + 配置 + 上报引擎。
 * 全部状态随实例走，支持多实例与测试隔离；`init()` 语义是「配置默认实例」的便捷入口。
 *
 * 生命周期：
 *  - init(options)：校验必填项 → 绑定配置 → 绑定离场监听。返回 false 表示校验失败未启动。
 *  - destroy()：停止上报（disabled）+ 清空总线/面包屑/开关。原生补丁的还原由
 *    instrumentation 层（browser）持有 original 引用自行负责（见 browser/replace.ts）。
 */

import type { InitOptions, ReportDataType, LogTypes } from '@simple-monitor/types'
import { HandlerRegistry } from './subscribe'
import { SilentFlags } from './flags'
import { Breadcrumb } from './breadcrumb'
import { Options } from './options'
import { TransportData } from './transportData'
import { BehaviorTracker, sanitizeTrackPayload } from './behavior'
import { SessionManager } from './session'
import { logToClient } from './external'
import { logger, setPrivacyMaskEnabled } from '@simple-monitor/utils'

export class MonitorClient {
  /** 事件总线：采集器 trigger，处理器 subscribe */
  readonly registry = new HandlerRegistry()
  /** 静默开关表 */
  readonly flags = new SilentFlags()
  /** 用户行为面包屑栈 */
  readonly breadcrumb = new Breadcrumb()
  /** 配置中心 */
  readonly options = new Options()
  /** 会话与用户标识 */
  readonly session = new SessionManager()
  /**
   * SPA 路由视图标识（M3）：browser 的路由采集在捕获时刻更新，
   * 错误/性能数据用它做「哪个路由页」归因。初始为空，setupReplace 时写入当前路由。
   */
  viewId: string = ''
  /** 上报引擎（依赖 breadcrumb/options/session 注入） */
  readonly transport: TransportData
  /** 行为域追踪器（M7 ADR-8）：独立信封组 + 按域采样 + 防风暴 */
  readonly behavior: BehaviorTracker

  /** init 是否已成功执行（幂等依据） */
  private initialized = false
  private destroyed = false

  constructor() {
    this.transport = new TransportData({
      breadcrumb: this.breadcrumb,
      options: this.options,
      session: this.session,
      getViewId: () => this.viewId,
    })
    this.behavior = new BehaviorTracker({
      getDsn: () => this.transport.trackDsn,
      getContext: () => ({
        apiKey: this.transport.apikey,
        release: this.transport.release,
        env: this.transport.env,
        sdkName: 'simple-monitor',
        sdkVersion: '0.1.0',
        sessionId: this.session.getSessionId(),
        trackerId: this.session.getTrackerId(),
        page: typeof location !== 'undefined' ? location.pathname : '',
        viewId: this.viewId,
        deviceInfo: this.transport.deviceInfo,
      }),
      getTrackSampleRate: () => this.options.trackSampleRate,
      getApiSampleRate: () => this.options.apiSampleRate,
    })
  }

  /**
   * 初始化客户端。校验失败（缺 dsn/apikey）返回 false 且不做任何绑定；
   * 重复调用直接返回 true（幂等，不重复绑定配置）。
   */
  init(options: InitOptions = {}): boolean {
    if (this.destroyed) {
      logger.error('MonitorClient 已销毁，无法重新 init；请创建新实例')
      return false
    }
    if (this.initialized) {
      logger.warn('MonitorClient 已初始化，重复 init() 已忽略')
      return true
    }
    if (!options.dsn || !options.apikey) {
      logger.error('初始化失败：dsn 与 apikey 为必填项，请在 init 中传入')
      return false
    }
    this.flags.bindOptions(options)
    // 隐私底线全局统一（utils 模块级开关）：默认开，显式传 false 才关
    setPrivacyMaskEnabled(options.enablePrivacyMask !== false)
    this.breadcrumb.bindOptions(options)
    logger.bindOptions(options.debug)
    this.transport.bindOptions(options)
    this.options.bindOptions(options)
    this.transport.bindLifecycle()
    this.initialized = true
    return true
  }

  /** 上报一条数据（错误 / 性能 / 行为），走 client 自己的上报引擎 */
  async send(data: ReportDataType | any): Promise<void> {
    return this.transport.send(data)
  }

  /**
   * 代码埋点（M7 ADR-8）：上报一条 track 事件（kind: behavior / behaviorType: track / from: api）
   * @param name 埋点名（≤128 字符）
   * @param props 埋点属性（键数 ≤32、序列化 ≤2KB，超限丢弃）
   */
  track(name: string, props?: Record<string, unknown>): void {
    const sanitized = sanitizeTrackPayload(name, props)
    if (!sanitized.name) return
    this.behavior.sendBehavior({
      behaviorType: 'track',
      name: sanitized.name,
      props: sanitized.props,
      from: 'api',
    })
  }

  /**
   * 代码测速（M7 ADR-8）：time(name) 返回 end 函数，调用时上报 track 事件（props.durationMs）。
   * duration 非有限数/负数/超 24h 静默丢弃（防风暴纪律）。
   */
  time(name: string): () => void {
    const start = Date.now()
    return () => {
      const durationMs = Date.now() - start
      if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 24 * 3600 * 1000) return
      this.track(name, { durationMs })
    }
  }

  /** 设置某类事件的静默开关 */
  setSilent(type: string, silent: boolean): void {
    this.flags.set(type, silent)
  }

  /** 查询某类事件是否静默 */
  isSilent(type: string): boolean {
    return this.flags.isSilent(type)
  }

  /** 手动上报日志（external.log 的实例方法形态） */
  log(options: LogTypes): void {
    logToClient(options, this)
  }

  /**
   * 停止客户端：停止上报、清空总线注册、清空面包屑与开关。
   * 原生 API 补丁还原见 browser instrumentation。
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.options.disabled = true
    this.registry.clear()
    this.breadcrumb.clear()
    this.flags.clear()
    // 丢弃批量缓冲并清掉 flush 定时器：销毁后不再有任何发送行为
    this.transport.destroy()
    this.behavior.destroy()
  }
}
