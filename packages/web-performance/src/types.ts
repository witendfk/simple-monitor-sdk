/** Web Performance 类型契约（对齐 encode，自包含、不依赖外部 types 包） */

export interface IConfig {
  appId?: string
  version?: string
  reportCallback: (data: IReportData) => void
  immediately: boolean
  isCustomEvent?: boolean
  logFpsCount?: number
  apiConfig?: {
    [prop: string]: Array<string>
  }
  hashHistory?: boolean
  excludeRemotePath?: Array<string>
  maxWaitCCPDuration?: number
  scoreConfig?: IScoreConfig
  /** 慢资源判定阈值（ms）：单个资源 duration >= 此值视为慢，默认 300 */
  resourceThreshold?: number
  /** 慢资源 Top-N 数量，默认 10 */
  resourceTopN?: number
  /**
   * 请求/路由事件源（ADR-3 统一拦截层）：web 门面注入 core 总线适配器，
   * 引擎不再自行劫持 xhr/fetch/history；独立使用不传，走自有 proxy 兜底。
   */
  eventSource?: IEventSource
}

export interface IPerformanceNavigationTiming {
  dnsLookup?: number
  initialConnection?: number
  ssl?: number
  ttfb?: number
  contentDownload?: number
  domParse?: number
  deferExecuteDuration?: number
  domContentLoadedCallback?: number
  resourceLoad?: number
  domReady?: number
  pageLoad?: number
}

export interface IDeviceInformation {
  deviceMemory?: number
  hardwareConcurrency?: number
  jsHeapSizeLimit?: number
  totalJSHeapSize?: number
  usedJSHeapSize?: number
}

export interface INetworkInformation {
  downlink?: number
  effectiveType?: IEffectiveType
  rtt?: number
}

export interface IScoreConfig {
  [prop: string]: { median: number; p10: number }
}

export interface IEffectiveType {
  type: '4g' | '3g' | '2g' | 'slow-2g'
}

export interface IPageInformation {
  host: string
  hostname: string
  href: string
  protocol: string
  origin: string
  port: string
  pathname: string
  search: string
  hash: string
  userAgent?: string
  screenResolution: string
}

export interface IMetrics {
  name: string
  value: any
  score?: number
}

export interface IWebVitals {
  immediately: boolean
  getCurrentMetrics(): IMetricsObj
  setStartMark(markName: string): void
  setEndMark(markName: string): void
  clearMark(markName: string): void
  customContentfulPaint(): void
}

export interface IReportHandler {
  /**
   * urgent=true 表示本次上报来自页面隐藏/卸载，必须同步送达回调——
   * requestIdleCallback 在页面销毁后不会执行，批量数据会整批丢失。
   */
  (metrics: IMetrics | IMetricsObj, urgent?: boolean): void
}

export interface PerformanceEntryHandler {
  (entry: PerformanceEntry): void
}

/** event entryType（INP 用）的交互时序条目 */
export interface PerformanceEventTiming extends PerformanceEntry {
  processingStart: DOMHighResTimeStamp
  processingEnd: DOMHighResTimeStamp
  duration: DOMHighResTimeStamp
  interactionId?: number
  cancelable?: boolean
  target?: Element
}

export interface OnHiddenCallback {
  (event: Event): void
}

export interface OnPageChangeCallback {
  (event?: Event): void
}

export interface IReportData {
  sessionId: string
  appId?: string
  version?: string
  data: IMetrics | IMetricsObj
  timestamp: number
}

export interface IMetricsObj {
  [prop: string]: IMetrics
}

/** 单个资源的加载阶段拆解（跨域无 TAO 时整体拿不到 → ResourceTimingEntry.stages = null） */
export interface ResourceStages {
  dnsLookup: number
  connection: number
  ssl: number
  ttfb: number
  download: number
}

/** 单个资源采集项 */
export interface ResourceTimingEntry {
  url: string
  initiatorType: string
  duration: number
  transferSize: number
  stages: ResourceStages | null
}

/** 资源耗时上报报告：慢资源 Top-N + 会话网络快照（上下文，不参与判定） */
export interface ResourceTimingReport {
  total: number
  threshold: number
  network: INetworkInformation
  slowTop: ResourceTimingEntry[]
}

export interface LayoutShift extends PerformanceEntry {
  value: number
  hadRecentInput: boolean
}

/** 对数正态分布评分曲线 */
export interface Curve {
  median: number
  podr?: number
  p10?: number
}

declare global {
  interface Window {
    __monitor_xhr__: boolean
    __monitor_fetch__: boolean
    __monitor_sessionId__: string
  }
}

/**
 * 请求/路由事件源（ADR-3：统一拦截层）。
 * 走 web 门面时由门面把 core 事件总线适配成本接口注入——
 * 性能引擎订阅数据而不再自行劫持 xhr/fetch/history，消灭双层包装；
 * 独立使用（不注入）时引擎保持自有 proxy 兜底。
 */
export interface IEventSource {
  /**
   * 订阅请求完成事件：每个业务请求（含失败）结束时回调一次 url。
   * 由 core 总线的 xhr/fetch 事件适配（monitorXhr.url / MonitorHttp.url）。
   */
  onRequest(complete: (url: string) => void): void
  /** 订阅 SPA 路由变化（pushState/replaceState/hashchange/popstate 归一） */
  onRoute(cb: () => void): void
}
