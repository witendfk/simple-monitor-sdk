/**
 * 数据上报模块（M2 可靠性引擎）
 *
 * send() 语义不变：去重（errorId）→ beforeDataReport 钩子 → 按 dsn 路由。
 * 通道层升级（ADR：批量信封取代逐条请求）：
 *  - 浏览器环境默认走 BatchSender（批量 + gzip + 重试 + IndexedDB 离线兜底）；
 *  - useImgUpload / 小程序环境保留旧通道（imgRequest / wxPost 逐条）；
 *  - beaconPost / xhrPost 保留为独立方法（离场同步通道 + 降级路径）。
 */

import type {
  TransportDataType,
  FinalReportType,
  AuthInfo,
  InitOptions,
  ITransportData,
  DeviceInfo,
  IBreadcrumb,
} from '@simple-monitor/types'
import { isReportDataType, isPerformanceData } from '@simple-monitor/types'
import type { TransportEnvelope } from '@simple-monitor/protocol'
import {
  Queue,
  sanitizePageUrl,
  isWxMiniEnv,
  isBrowserEnv,
  logger,
  getGlobal,
  validateOption,
  isEmpty,
} from '@simple-monitor/utils'
import { createErrorId } from './errorId'
import { SDK_VERSION, SDK_NAME } from '@simple-monitor/shared'
import { toErrorEvent, toPerfEvent, buildEnvelope } from './envelope'
import { BatchSender } from './batchSender'
import { SessionManager } from './session'
import type { ClientOptions } from './options'

// 获取全局对象
const _global = getGlobal<any>()

/** TransportData 的运行时依赖（由 client 注入） */
export interface TransportDeps {
  breadcrumb: IBreadcrumb
  options: ClientOptions
  session: SessionManager
  /** 当前路由视图（信封 context.viewId；错误事件自带采集时刻的 viewId） */
  getViewId: () => string
}

/**
 * 数据上报类
 */
export class TransportData implements ITransportData {
  queue: Queue
  beforeDataReport: InitOptions['beforeDataReport']
  backTrackerId: InitOptions['backTrackerId']
  configReportXhr: InitOptions['configReportXhr']
  configReportUrl: InitOptions['configReportUrl']
  configReportWxRequest: InitOptions['configReportWxRequest']
  useImgUpload: boolean
  apikey: string
  trackKey: string
  errorDsn: string
  trackDsn: string
  /** 发版标识（发版关联分析的核心维度） */
  release?: string
  /** 环境标识：production / staging / dev */
  env?: string

  private readonly breadcrumb: IBreadcrumb
  private readonly options: ClientOptions
  private readonly session: SessionManager
  private readonly getViewId: () => string
  /** 设备信息快照（采集端 setup 时写入，信封组装取用） */
  deviceInfo?: DeviceInfo
  private readonly sender: BatchSender
  private lifecycleBound = false
  private replayed = false

  constructor(deps: TransportDeps) {
    this.breadcrumb = deps.breadcrumb
    this.options = deps.options
    this.session = deps.session
    this.getViewId = deps.getViewId
    this.queue = new Queue()
    this.beforeDataReport = undefined
    this.backTrackerId = undefined
    this.configReportXhr = undefined
    this.configReportUrl = undefined
    this.configReportWxRequest = undefined
    this.useImgUpload = false
    this.apikey = ''
    this.trackKey = ''
    this.errorDsn = ''
    this.trackDsn = ''
    this.sender = new BatchSender({
      buildEnvelope: (payloads) => this.buildEnvelopeFor(payloads),
      // 兼容 configReportUrl 钩子：批量通道在信封级调用（返回 falsy 取消发送，与旧语义一致）
      beforeSend: (envelope, dsn) => {
        if (typeof this.configReportUrl !== 'function') return dsn
        try {
          const custom = this.configReportUrl(envelope as unknown as TransportDataType, dsn)
          return custom || false
        } catch (error) {
          logger.error('configReportUrl hook error:', error)
          return false
        }
      },
    })
  }

  /**
   * 把一批载荷组装成协议信封（供 BatchSender 回调）
   * 错误事件附带当前面包屑快照（flush 时刻的行为栈，覆盖错误到上报之间的操作）
   */
  private buildEnvelopeFor(
    payloads: Array<{ dsn: string; data: any }>
  ): { dsn: string; envelope: TransportEnvelope } | null {
    if (payloads.length === 0) return null
    const events = []
    for (const { data } of payloads) {
      if (isPerformanceData(data)) {
        const perfEvent = toPerfEvent(data.metrics ?? {})
        if (perfEvent) events.push(perfEvent)
      } else if (isReportDataType(data)) {
        events.push(toErrorEvent(data, this.breadcrumb.getStack()))
      }
    }
    if (events.length === 0) return null
    const envelope = buildEnvelope(
      {
        apiKey: this.apikey,
        release: this.release,
        env: this.env,
        sdkName: SDK_NAME,
        sdkVersion: SDK_VERSION,
        sessionId: this.session.getSessionId(),
        trackerId: String(this.getTrackerId()),
        page: sanitizePageUrl(_global?.location?.href ?? ''),
        viewId: this.getViewId() || undefined,
        deviceInfo: this.deviceInfo,
      },
      events
    )
    return { dsn: payloads[0].dsn, envelope }
  }

  /**
   * 绑定配置项（使用 validateOption 验证）
   */
  bindOptions(options: InitOptions = {}): void {
    const {
      dsn,
      trackDsn,
      apikey,
      trackKey,
      useImgUpload,
      beforeDataReport,
      configReportXhr,
      configReportUrl,
      configReportWxRequest,
      backTrackerId,
      release,
      env,
    } = options

    if (validateOption(dsn, 'dsn', 'string')) this.errorDsn = dsn ?? ''
    // 性能数据走 trackDsn 通道；未配置（或显式空串）时回落 dsn，
    // 否则 send() 会因 trackDsn 为空而静默丢弃全部性能上报（总纲 §3.1 红线修复）
    if (validateOption(trackDsn, 'trackDsn', 'string') && trackDsn) {
      this.trackDsn = trackDsn
    } else if (this.errorDsn) {
      this.trackDsn = this.errorDsn
    }
    if (validateOption(apikey, 'apikey', 'string')) this.apikey = apikey ?? ''
    if (validateOption(trackKey, 'trackKey', 'string')) this.trackKey = trackKey ?? ''
    if (validateOption(useImgUpload, 'useImgUpload', 'boolean'))
      this.useImgUpload = useImgUpload ?? false
    if (validateOption(beforeDataReport, 'beforeDataReport', 'function'))
      this.beforeDataReport = beforeDataReport
    if (validateOption(configReportXhr, 'configReportXhr', 'function'))
      this.configReportXhr = configReportXhr
    if (validateOption(configReportUrl, 'configReportUrl', 'function'))
      this.configReportUrl = configReportUrl
    if (validateOption(configReportWxRequest, 'configReportWxRequest', 'function'))
      this.configReportWxRequest = configReportWxRequest
    if (validateOption(backTrackerId, 'backTrackerId', 'function'))
      this.backTrackerId = backTrackerId
    if (validateOption(release, 'release', 'string')) this.release = release
    if (validateOption(env, 'env', 'string')) this.env = env
  }

  /**
   * 获取 TrackerId
   * 优先使用用户自定义的 backTrackerId，否则使用 SessionManager（localStorage 级）
   */
  getTrackerId(): string | number {
    if (typeof this.backTrackerId === 'function') {
      try {
        const trackerId = this.backTrackerId()
        if (typeof trackerId === 'string' || typeof trackerId === 'number') {
          return trackerId
        }
        logger.error(
          `trackerId:${trackerId} 期望 string 或 number 类型，但是传入类型为 ${typeof trackerId}`
        )
      } catch (error) {
        // 用户钩子异常不逃逸（send 是 fire-and-forget 调用，逃逸即 unhandled rejection）
        logger.error('backTrackerId hook error:', error)
      }
    }
    return this.session.getTrackerId()
  }

  /**
   * 获取认证信息（M2 增加 sessionId / release / env）
   */
  getAuthInfo(): AuthInfo {
    const trackerId = this.getTrackerId()
    const result: AuthInfo = {
      trackerId: String(trackerId),
      sdkVersion: SDK_VERSION,
      sdkName: SDK_NAME,
    }
    this.apikey && (result.apikey = this.apikey)
    this.trackKey && (result.trackKey = this.trackKey)
    this.release && (result.release = this.release)
    this.env && (result.env = this.env)
    return result
  }

  /**
   * 获取设备信息（采集端 setup 时写入 transportData.deviceInfo）
   */
  getDeviceInfo(): DeviceInfo | any {
    return this.deviceInfo || {}
  }

  /**
   * 组装完整的上报数据（旧逐条信封；批量通道在 BatchSender 内按协议组装）
   */
  getTransportData(data: FinalReportType): TransportDataType {
    return {
      authInfo: this.getAuthInfo(),
      breadcrumb: this.breadcrumb.getStack(),
      data,
      deviceInfo: this.getDeviceInfo(),
    }
  }

  /**
   * 判断目标 URL 是否为 SDK 的上报地址
   * 使用 indexOf 支持子路径匹配
   */
  isSdkTransportUrl(targetUrl: string): boolean {
    if (!targetUrl) return false
    let isSdkDsn = false
    if (this.errorDsn && targetUrl.indexOf(this.errorDsn) !== -1) {
      isSdkDsn = true
    }
    if (this.trackDsn && targetUrl.indexOf(this.trackDsn) !== -1) {
      isSdkDsn = true
    }
    return isSdkDsn
  }

  /**
   * 上报前数据处理
   * 生成 errorId 并执行钩子
   */
  async beforePost(data: FinalReportType): Promise<TransportDataType | false> {
    // 如果是错误数据，生成 errorId（性能数据不去重，跳过）
    if (!isPerformanceData(data) && isReportDataType(data) && this.apikey) {
      const errorId = createErrorId(data, this.apikey, this.options.maxDuplicateCount)
      if (errorId === null) {
        // 重复错误超过阈值，不上报
        return false
      }
      data.errorId = errorId
    }

    let transportData = this.getTransportData(data)

    // 执行 beforeDataReport 钩子
    if (typeof this.beforeDataReport === 'function') {
      try {
        const result = await Promise.resolve(this.beforeDataReport(transportData))
        if (!result) return false
        transportData = result as TransportDataType
      } catch (error) {
        logger.error('beforeDataReport hook error:', error)
        return false
      }
    }

    return transportData
  }

  /**
   * 使用 XHR 上报数据（队列模式；旧通道：img 模式 / 降级路径）
   */
  xhrPost(data: TransportDataType, url: string): void {
    const requestFun = (): void => {
      const XHRConstructor = _global.XMLHttpRequest
      if (!XHRConstructor) {
        logger.error('XMLHttpRequest is not supported')
        return
      }

      const xhr = new XHRConstructor()
      xhr.open('POST', url, true)
      xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8')
      xhr.withCredentials = true

      // 执行 configReportXhr 钩子
      if (typeof this.configReportXhr === 'function') {
        try {
          this.configReportXhr(xhr, data)
        } catch (error) {
          logger.error('configReportXhr hook error:', error)
        }
      }

      try {
        xhr.send(JSON.stringify(data))
      } catch (error) {
        logger.error('XHR send error:', error)
      }
    }
    this.queue.addFn(requestFun)
  }

  /**
   * 使用 Image 方式上报数据（智能 URL 拼接）
   */
  imgRequest(data: TransportDataType, url: string): void {
    const requestFun = (): void => {
      const ImgConstructor = _global.Image
      if (!ImgConstructor) {
        logger.error('Image is not supported')
        return
      }

      try {
        const img = new ImgConstructor()
        const spliceStr = url.indexOf('?') === -1 ? '?' : '&'
        img.src = `${url}${spliceStr}data=${encodeURIComponent(JSON.stringify(data))}`
      } catch (error) {
        logger.error('imgRequest error:', error)
      }
    }
    this.queue.addFn(requestFun)
  }

  /**
   * 使用微信小程序 wx.request 上报数据（队列模式）
   */
  wxPost(data: TransportDataType, url: string): void {
    const requestFun = (): void => {
      const wx = _global.wx
      if (!wx || !wx.request) {
        logger.error('wx.request is not available')
        return
      }

      let requestOptions: any = {
        method: 'POST',
        data,
        url,
      }

      // 执行 configReportWxRequest 钩子
      if (typeof this.configReportWxRequest === 'function') {
        try {
          const params = this.configReportWxRequest(data)
          if (params) {
            requestOptions = { ...requestOptions, ...params }
          }
        } catch (error) {
          logger.error('configReportWxRequest hook error:', error)
        }
      }

      wx.request(requestOptions)
    }
    this.queue.addFn(requestFun)
  }

  /**
   * 使用 navigator.sendBeacon 上报（离场同步通道，浏览器保证发出）。
   * 不可用或排队失败时降级到 xhrPost。数据以 JSON 字符串发送。
   */
  beaconPost(data: TransportDataType, url: string): void {
    const beacon = (_global.navigator as any)?.sendBeacon
    if (typeof beacon === 'function') {
      try {
        if (beacon.call(_global.navigator, url, JSON.stringify(data))) return
      } catch (error) {
        logger.error('sendBeacon error:', error)
      }
    }
    // 降级到 XHR
    this.xhrPost(data, url)
  }

  /**
   * 生命周期绑定：pagehide/hidden → sender.markLeaving（立即 beacon）；
   * pageshow/visible → sender.markActive（复位，修复旧版粘滞 bug）。
   * 首次绑定时触发离线缓存重放（fire-and-forget）。
   */
  bindLifecycle(): void {
    if (this.lifecycleBound) return
    this.lifecycleBound = true
    if (!_global || typeof _global.addEventListener !== 'function') return
    try {
      _global.addEventListener('pagehide', () => this.sender.markLeaving())
      _global.addEventListener('pageshow', () => this.sender.markActive())
      const doc = _global.document
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', () => {
          if (doc.visibilityState === 'hidden') this.sender.markLeaving()
          else this.sender.markActive()
        })
      }
    } catch (error) {
      logger.error('bindLifecycle error:', error)
    }
    if (!this.replayed) {
      this.replayed = true
      void this.sender.replay()
    }
  }

  /** 性能数据采样（总纲 §五规格 2：错误 100%，perf 按 sampleRate） */
  private shouldSamplePerf(): boolean {
    const rate = this.options.sampleRate
    if (rate === undefined || rate >= 1) return true
    if (rate <= 0) return false
    return Math.random() < rate
  }

  /**
   * 核心发送方法
   * 根据环境和配置选择上报方式
   */
  async send(data: FinalReportType): Promise<void> {
    try {
      await this.sendInner(data)
    } catch (error) {
      // send 是各 handler 的 fire-and-forget 调用（nativeTryCatch 只挡同步异常）：
      // 任何异步异常必须在此消化，监控 SDK 不允许产生 unhandled rejection
      logger.error('transport send error:', error)
    }
  }

  private async sendInner(data: FinalReportType): Promise<void> {
    // disabled：完全关闭上报（采集器仍装载、面包屑仍记录，但不发出请求）
    if (this.options.disabled) return
    let dsn = ''

    // 判断数据类型并选择对应的 DSN
    // 性能数据走 trackDsn（埋点通道），不走 error 去重
    if (isPerformanceData(data)) {
      // 性能采样：在采集出口过滤（省流量也省内存）
      if (!this.shouldSamplePerf()) return
      dsn = this.trackDsn
      if (isEmpty(dsn)) {
        logger.error('trackDsn为空，没有传入埋点上报的dsn地址，请在init中传入')
        return
      }
    } else if (isReportDataType(data)) {
      dsn = this.errorDsn
      if (isEmpty(dsn)) {
        logger.error('dsn为空，没有传入监控错误上报的dsn地址，请在init中传入')
        return
      }
    } else {
      dsn = this.trackDsn
      if (isEmpty(dsn)) {
        logger.error('trackDsn为空，没有传入埋点上报的dsn地址，请在init中传入')
        return
      }
    }

    // 执行 beforePost 处理（去重 + 钩子）
    const result = await this.beforePost(data)
    if (!result) return

    // 根据环境选择上报方式
    if (isBrowserEnv) {
      // 图片通道（旧配置）保持逐条
      if (this.useImgUpload) return this.imgRequest(result, dsn)
      // M2：批量信封通道（BatchSender 内部处理 active/leaving 状态与降级）
      this.sender.add(dsn, result.data)
      return
    }
    if (isWxMiniEnv) {
      return this.wxPost(result, dsn)
    }
  }

  /** 立即 flush 全部缓冲（测试/销毁前用） */
  async flush(): Promise<void> {
    await this.sender.flushAll()
  }

  /** 销毁上报通道：丢弃缓冲、清掉定时器——销毁后不再有任何发送行为 */
  destroy(): void {
    this.sender.reset()
    this.queue.clear()
  }

  /** 当前缓冲条数（测试观测用） */
  get bufferedCount(): number {
    return this.sender.bufferedCount
  }
}

// SessionManager 由 client 装配时创建；此处导出类型引用方便测试
export { SessionManager }
