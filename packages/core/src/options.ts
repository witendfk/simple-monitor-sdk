import { InitOptions } from '@simple-monitor/types'
import { generateUUID, toStringValidateOption, validateOption } from '@simple-monitor/utils'

/**
 * 客户端配置中心（M1 类化，ADR-1）
 *
 * 旧实现是 _support 单例；现在随 MonitorClient 实例走，可多实例、可隔离测试。
 * wx-mini 专属钩子已随死配置清理移除（总纲 §3.5），小程序采集包实装时再恢复。
 */
export class Options {
  enableTraceId: boolean = false
  filterXhrUrlRegExp?: RegExp
  includeHttpUrlTraceIdRegExp?: RegExp
  /** 注入请求头的追踪字段名；默认 W3C Trace Context 的 `traceparent`（ADR-7） */
  traceIdFieldName: string = 'traceparent'
  throttleDelayTime: number = 200
  maxDuplicateCount: number = 2
  /** 性能数据采样率 0~1（默认 1 不采样；错误始终 100% 上报，docs/SPEC.md 采样规格） */
  sampleRate: number = 1
  /** 行为域采样率（默认 1） */
  trackSampleRate: number = 1
  /** 成功请求明细采样率（默认 0.1） */
  apiSampleRate: number = 0.1
  disabled: boolean = false
  onRouteChange?: InitOptions['onRouteChange']

  bindOptions(options: InitOptions = {}): void {
    const {
      enableTraceId,
      filterXhrUrlRegExp,
      traceIdFieldName,
      throttleDelayTime,
      includeHttpUrlTraceIdRegExp,
      maxDuplicateCount,
      sampleRate,
      trackSampleRate,
      apiSampleRate,
      disabled,
      onRouteChange,
    } = options
    if (validateOption(enableTraceId, 'enableTraceId', 'boolean')) {
      this.enableTraceId = !!enableTraceId
    }
    if (validateOption(traceIdFieldName, 'traceIdFieldName', 'string')) {
      this.traceIdFieldName = String(traceIdFieldName)
    }
    if (validateOption(throttleDelayTime, 'throttleDelayTime', 'number')) {
      this.throttleDelayTime = Number(throttleDelayTime)
    }
    if (validateOption(maxDuplicateCount, 'maxDuplicateCount', 'number')) {
      this.maxDuplicateCount = Number(maxDuplicateCount)
    }
    if (validateOption(sampleRate, 'sampleRate', 'number')) {
      const r = Number(sampleRate)
      // 越界值收敛到 [0,1]
      this.sampleRate = Math.min(1, Math.max(0, r))
    }
    if (validateOption(trackSampleRate, 'trackSampleRate', 'number')) {
      this.trackSampleRate = Math.min(1, Math.max(0, Number(trackSampleRate) || 0))
    }
    if (validateOption(apiSampleRate, 'apiSampleRate', 'number')) {
      this.apiSampleRate = Math.min(1, Math.max(0, Number(apiSampleRate) || 0))
    }
    validateOption(disabled, 'disabled', 'boolean') && (this.disabled = !!disabled)
    validateOption(onRouteChange, 'onRouteChange', 'function') &&
      (this.onRouteChange = onRouteChange)
    toStringValidateOption(filterXhrUrlRegExp, 'filterXhrUrlRegExp', '[object RegExp]') &&
      (this.filterXhrUrlRegExp = filterXhrUrlRegExp)
    toStringValidateOption(
      includeHttpUrlTraceIdRegExp,
      'includeHttpUrlTraceIdRegExp',
      '[object RegExp]'
    ) && (this.includeHttpUrlTraceIdRegExp = includeHttpUrlTraceIdRegExp)
  }

  /**
   * 判定请求是否需要注入追踪头，命中则回调（headerName, traceId）。
   *
   * ADR-7：默认产出 W3C traceparent 格式（00-<32hex>-<16hex>-01），
   * 请求头与 HTTP 错误上报里的 traceId 对齐，服务端可据此关联前后端链路。
   */
  resolveTraceId(
    httpUrl: string,
    callback: (headerFieldName: string, traceId: string) => void
  ): void {
    if (!this.enableTraceId || !this.includeHttpUrlTraceIdRegExp) return
    if (!this.includeHttpUrlTraceIdRegExp.test(httpUrl)) return
    callback(this.traceIdFieldName, createTraceParent())
  }
}

/** client 内部引用别名（避免与 InitOptions 命名混淆） */
export type ClientOptions = Options

/** W3C Trace Context：version 00 + 32hex traceId + 16hex spanId + flags 01 */
export function createTraceParent(): string {
  return `00-${generateUUID().replace(/-/g, '')}-${generateUUID().replace(/-/g, '').slice(0, 16)}-01`
}
