import { BreadcrumbPushData, IBreadcrumb } from './breadcrumb'
import { TransportDataType } from './transportData'
type CANCEL = null | undefined | boolean

export interface InitOptions
  extends SilentEventTypes, HooksTypes, WxSilentEventTypes, BrowserHooksTypes {
  dsn?: string
  disabled?: boolean
  apikey?: string
  useImgUpload?: boolean
  trackKey?: string
  debug?: boolean
  enableTraceId?: boolean
  includeHttpUrlTraceIdRegExp?: RegExp
  traceIdFieldName?: string
  filterXhrUrlRegExp?: RegExp
  maxBreadcrumbs?: number
  throttleDelayTime?: number
  trackDsn?: string
  maxDuplicateCount?: number
  /** 隐私脱敏开关（默认开）：遮蔽手机号/身份证/卡号/凭证，作用于 DOM 文本/console/HTTP body 三入口 */
  enablePrivacyMask?: boolean
  /** 发版标识（如 'v1.2.3'）：发版关联/回归检测的核心维度 */
  release?: string
  /** 环境标识：production / staging / dev */
  env?: string
  /** 性能数据采样率 0~1（默认 1；错误始终 100% 上报） */
  sampleRate?: number
  /** 性能采集开关（默认开，false 关闭 web-performance 采集） */
  performance?: boolean
  /** 慢资源判定阈值 ms（默认 300），透传给 web-performance RT */
  resourceThreshold?: number
  /** 慢资源 Top-N（默认 10），透传给 web-performance RT */
  resourceTopN?: number
}

export interface HooksTypes {
  configReportXhr?(xhr: XMLHttpRequest, reportData: TransportDataType | any): void

  /** wx.request 上报通道配置（wx 环境使用；configReportWxRequest 保留，其余 wx 生命周期钩子已随死配置清理移除） */
  configReportWxRequest?(event: TransportDataType | any): unknown

  beforeDataReport?(
    event: TransportDataType
  ): Promise<TransportDataType | null | CANCEL> | TransportDataType | any | CANCEL | null
  /**
   *
   * 钩子函数，每次发送前都会调用
   * @param {TransportDataType} event 上报的数据格式
   * @param {string} url 上报到服务端的地址
   * @returns {string} 返回空时不上报
   * @memberof HooksTypes
   */
  configReportUrl?(event: TransportDataType, url: string): string

  beforePushBreadcrumb?(
    breadcrumb: IBreadcrumb,
    hint: BreadcrumbPushData
  ): BreadcrumbPushData | CANCEL

  backTrackerId?(): string | number
}

export interface SilentEventTypes {
  silentXhr?: boolean
  silentFetch?: boolean
  silentConsole?: boolean
  silentDom?: boolean
  silentHistory?: boolean
  silentError?: boolean
  /** 资源加载错误独立开关（旧版被 silentError 连带静默且无法单独控制） */
  silentResource?: boolean
  silentUnhandledrejection?: boolean
  silentHashchange?: boolean
  silentVue?: boolean
}

export interface WxSilentEventTypes {
  silentWxOnError?: boolean
  silentWxOnUnhandledRejection?: boolean
  silentWxOnPageNotFound?: boolean
  silentWxOnShareAppMessage?: boolean
  silentMiniRoute?: boolean
}

export type IWxPageInstance = WechatMiniprogram.Page.Instance<WechatMiniprogram.IAnyObject>

export interface BrowserHooksTypes {
  onRouteChange?: (from: string, to: string) => unknown
}
