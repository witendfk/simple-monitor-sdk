/**
 * 手动上报 API
 * 提供给业务方的主动监控接口，允许开发者手动上报错误和日志
 */

import { ErrorTypes, BreadCrumbTypes, Severity, SeverityUtils } from '@simple-monitor/types'
import type { LogTypes, IBreadcrumb } from '@simple-monitor/types'
import {
  isError,
  extractErrorStack,
  getLocationHref,
  getTimestamp,
  unknownToString,
  isWxMiniEnv,
  getCurrentRoute,
} from '@simple-monitor/utils'
import type { MonitorClient } from './client'
import { getDefaultMonitorClient } from './global'

/**
 * 将一条手动日志写入指定 client（面包屑 + send）
 */
export function logToClient(
  { message = 'emptyMsg', tag = '', level = Severity.Critical, ex = '', type = ErrorTypes.LOG_ERROR }: LogTypes,
  client: MonitorClient
): void {
  // 如果是 Error 对象，提取堆栈信息
  let errorInfo: any = {}
  if (isError(ex)) {
    const stackResult = extractErrorStack(ex, level)
    if (stackResult) {
      errorInfo = stackResult
    }
  }

  // 组装错误数据
  const error = {
    type,
    level,
    message: unknownToString(message),
    name: 'Monitor.log',
    customTag: unknownToString(tag),
    time: getTimestamp(),
    url: isWxMiniEnv ? getCurrentRoute() : getLocationHref(),
    ...errorInfo,
  }

  // 添加到用户行为栈
  const breadcrumb: IBreadcrumb = client.breadcrumb
  breadcrumb.push({
    type: BreadCrumbTypes.CUSTOMER,
    category: breadcrumb.getCategory(BreadCrumbTypes.CUSTOMER),
    data: message,
    level: SeverityUtils.fromString(level.toString()),
  })

  // 发送到服务端
  client.send(error)
}

/**
 * 手动上报日志（默认 client 的便捷入口）
 */
export function log(options: LogTypes): void {
  logToClient(options, getDefaultMonitorClient())
}
