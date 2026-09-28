import {
  BreadCrumbTypes,
  ErrorTypes,
  Severity,
  SeverityUtils,
  MonitorHttp,
  ResourceErrorTarget,
  IBreadcrumb,
  ReportDataType,
} from '@simple-monitor/types'
import { getLocationHref, getTimestamp, interceptStr } from '@simple-monitor/utils'
import { getRealPath } from './errorId'

/**
 * 跨域/超时区分阈值：status=0 且耗时 <= 阈值判为跨域或域名不存在，否则判为超时。
 * 纯参数注入（旧实现从 types globalVar 读模块常量）。
 */
export const CROSS_ORIGIN_THRESHOLD = 1000

enum SpanStatus {
  Ok = 'ok',
  DeadlineExceeded = 'deadline_exceeded',
  Unauthenticated = 'unauthenticated',
  PermissionDenied = 'permission_denied',
  NotFound = 'not_found',
  ResourceExhausted = 'resource_exhausted',
  InvalidArgument = 'invalid_argument',
  Unimplemented = 'unimplemented',
  Unavailable = 'unavailable',
  InternalError = 'internal_error',
  UnknownError = 'unknown_error',
  Cancelled = 'cancelled',
  AlreadyExists = 'already_exists',
}

function fromHttpStatus(status: number): SpanStatus {
  if (status >= 100 && status < 300) {
    return SpanStatus.Ok
  }
  if (status === 400) {
    return SpanStatus.InvalidArgument
  }
  if (status === 401) {
    return SpanStatus.Unauthenticated
  }
  if (status === 403) {
    return SpanStatus.PermissionDenied
  }
  if (status === 404) {
    return SpanStatus.NotFound
  }
  if (status === 409) {
    return SpanStatus.AlreadyExists
  }
  if (status === 429) {
    return SpanStatus.ResourceExhausted
  }
  if (status >= 500 && status < 600) {
    return SpanStatus.InternalError
  }
  if (status === 501) {
    return SpanStatus.Unimplemented
  }
  if (status === 503) {
    return SpanStatus.Unavailable
  }
  if (status === 504) {
    return SpanStatus.DeadlineExceeded
  }
  return SpanStatus.UnknownError
}

interface TriggerConsole {
  level: string
  args: unknown[]
}

/**
 * HTTP 错误分类 - 区分跨域限制、超时、不同 HTTP 状态码
 */
export function httpTransform(
  data: MonitorHttp,
  crossOriginThreshold: number = CROSS_ORIGIN_THRESHOLD
): ReportDataType {
  let message = ''
  const { elapsedTime = 0, time, method = '', traceId, type, status = 0 } = data
  const name = `${type}--${method}`

  if (status === 0) {
    message =
      elapsedTime <= crossOriginThreshold
        ? 'http请求失败，失败原因：跨域限制或域名不存在'
        : 'http请求失败，失败原因：超时'
  } else {
    message = fromHttpStatus(status)
  }

  message = message === SpanStatus.Ok ? message : `${message} ${getRealPath(data.url || '')}`

  return {
    type: ErrorTypes.FETCH_ERROR,
    url: getLocationHref(),
    time,
    elapsedTime,
    level: Severity.Low,
    message,
    name,
    request: {
      httpType: type,
      traceId,
      method,
      url: data.url || '',
      data: data.reqData || '',
    },
    response: {
      status,
      data: data.responseText,
    },
  }
}

/**
 * 资源错误映射 - 将 <img>、<script> 等标签的加载失败转换为可读的错误信息
 */
const resourceMap: Record<string, string> = {
  img: '图片',
  script: 'js脚本',
  css: '样式',
  link: '资源',
}

export function resourceTransform(target: ResourceErrorTarget): ReportDataType {
  return {
    type: ErrorTypes.RESOURCE_ERROR,
    url: getLocationHref(),
    message:
      '资源地址: ' + (interceptStr(target.src || '', 120) || interceptStr(target.href || '', 120)),
    level: Severity.Low,
    time: getTimestamp(),
    name: `${resourceMap[target.localName || ''] || target.localName}加载失败`,
  }
}

/**
 * Console 集成 - 将 console 调用写入面包屑（受 breadcrumb 所在 client 的配置控制）。
 * breadcrumb 参数注入（M1：不再隐式引用模块单例）。
 */
export function handleConsole(data: TriggerConsole, breadcrumb: IBreadcrumb): void {
  breadcrumb.push({
    type: BreadCrumbTypes.CONSOLE,
    category: breadcrumb.getCategory(BreadCrumbTypes.CONSOLE),
    data: {
      level: data.level,
      args: data.args,
    },
    level: SeverityUtils.fromString(data.level),
    time: getTimestamp(),
  })
}
