/**
 * 数据上报模块
 * 负责将转换后的数据组装成完整的上报 payload，并通过多种方式发送到服务端
 */

import type {
  TransportDataType,
  FinalReportType,
  AuthInfo,
  InitOptions,
  ITransportData,
  DeviceInfo,
} from '@simple-monitor/types'
import { isReportDataType, isPerformanceData } from '@simple-monitor/types'
import {
  Queue,
  generateUUID,
  isWxMiniEnv,
  isBrowserEnv,
  logger,
  getGlobal,
  validateOption,
  isEmpty,
} from '@simple-monitor/utils'
import { breadcrumb } from './breadcrumb'
import { createErrorId } from './errorId'
import { _support } from './global'
import { options } from './options'
import { SDK_VERSION, SDK_NAME } from '@simple-monitor/shared'

// 获取全局对象
const _global = getGlobal<any>()

/**
 * 获取默认 TrackerId（内部方法）
 * 从 localStorage 读取或生成 UUID，作为 getTrackerId 的后备默认实现
 */
function getDefaultTrackerId(): string {
  const storage = _global.localStorage
  if (!storage) return generateUUID()

  const trackerId = storage.getItem('simple-monitor-tracker-id')
  if (trackerId) return trackerId
  const newTrackerId = generateUUID()
  storage.setItem('simple-monitor-tracker-id', newTrackerId)
  return newTrackerId
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
  private isUnloading = false

  constructor() {
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
    this.setupUnloadListener()
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
  }

  /**
   * 获取 TrackerId
   * 优先使用用户自定义的 backTrackerId，否则使用默认实现（从 localStorage 读取或生成 UUID）
   */
  getTrackerId(): string | number {
    if (typeof this.backTrackerId === 'function') {
      const trackerId = this.backTrackerId()
      if (typeof trackerId === 'string' || typeof trackerId === 'number') {
        return trackerId
      }
      logger.error(
        `trackerId:${trackerId} 期望 string 或 number 类型，但是传入类型为 ${typeof trackerId}`
      )
    }
    return getDefaultTrackerId()
  }

  /**
   * 获取 apikey
   */
  getApikey(): string {
    return this.apikey
  }

  /**
   * 获取 trackKey
   */
  getTrackKey(): string {
    return this.trackKey
  }

  /**
   * 获取认证信息
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
    return result
  }

  /**
   * 获取设备信息（优先从 _support 获取）
   */
  getDeviceInfo(): DeviceInfo | any {
    return _support.deviceInfo || {}
  }

  /**
   * 组装完整的上报数据
   */
  getTransportData(data: FinalReportType): TransportDataType {
    return {
      authInfo: this.getAuthInfo(),
      breadcrumb: breadcrumb.getStack(),
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
      const errorId = createErrorId(data, this.apikey)
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
   * 使用 XHR 上报数据（队列模式）
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
   * 使用 navigator.sendBeacon 上报（页面卸载场景，浏览器保证发出）。
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
   * 监听页面卸载（pagehide / visibilitychange→hidden）置 isUnloading 标记，
   * send 据此切 sendBeacon 通道（XHR 在 unload 会丢数据）。非浏览器环境跳过。
   */
  private setupUnloadListener(): void {
    // 非浏览器环境（无 addEventListener / document）跳过；
    // 用 _global 而非直接 window/document，保持 core 框架无关、不依赖 DOM 类型
    if (!_global || typeof _global.addEventListener !== 'function') return
    const markUnloading = (): void => {
      this.isUnloading = true
    }
    try {
      _global.addEventListener('pagehide', markUnloading)
      const doc = _global.document
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', () => {
          if (doc.visibilityState === 'hidden') markUnloading()
        })
      }
    } catch (error) {
      logger.error('setupUnloadListener error:', error)
    }
  }

  /**
   * 核心发送方法
   * 根据环境和配置选择上报方式
   */
  async send(data: FinalReportType): Promise<void> {
    // disabled：完全关闭上报（采集器仍装载、面包屑仍记录，但不发出请求）
    if (options.disabled) return
    let dsn = ''

    // 判断数据类型并选择对应的 DSN
    // 性能数据走 trackDsn（埋点通道），不走 error 去重
    if (isPerformanceData(data)) {
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

    // 执行 beforePost 处理
    const result = await this.beforePost(data)
    if (!result) return

    // 执行 configReportUrl 钩子
    if (typeof this.configReportUrl === 'function') {
      try {
        const customUrl = this.configReportUrl(result, dsn)
        if (!customUrl) return
        dsn = customUrl
      } catch (error) {
        logger.error('configReportUrl hook error:', error)
        return
      }
    }

    // 根据环境选择上报方式
    if (isBrowserEnv) {
      if (this.useImgUpload) return this.imgRequest(result, dsn)
      // 页面卸载时优先 sendBeacon（浏览器保证发出，XHR 在 unload 会丢）
      if (this.isUnloading) return this.beaconPost(result, dsn)
      return this.xhrPost(result, dsn)
    }
    if (isWxMiniEnv) {
      return this.wxPost(result, dsn)
    }
  }
}

const transportData = _support.transportData || (_support.transportData = new TransportData())

export { transportData }
