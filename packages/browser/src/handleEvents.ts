/**
 * 事件处理器（handleEvents）
 *
 * 每个 handler 通过 client.registry 注册一条「订阅 + transform + send」的同质逻辑。
 * 只暴露处理入口，不直接绑定原生 API——那是 replace.ts 的职责。
 *
 * M1：全部 handler 接收 client（静默开关 / 面包屑 / 上报 / filterXhrUrlRegExp 均从实例读），
 * 显式注册 id 保证幂等（ADR-1 / 总纲 §3.3）。
 */

import {
  EventTypes,
  ErrorTypes,
  Severity,
  BreadCrumbTypes,
  HttpTypes,
} from '@simple-monitor/types'
import { extractErrorStack, getTimestamp } from '@simple-monitor/utils'
import { resourceTransform, httpTransform } from '@simple-monitor/core'
import { handleConsole } from '@simple-monitor/core'
import type { MonitorClient } from '@simple-monitor/core'
import type { ResourceErrorTarget, MonitorHttp } from '@simple-monitor/types'

/**
 * 订阅 JS 运行时错误（window error 事件分流后的代码错误通道）
 */
export function handleError(client: MonitorClient): void {
  client.registry.subscribe({
    type: EventTypes.ERROR,
    id: 'browser.js-error',
    callback: (data) => {
      if (client.isSilent(EventTypes.ERROR)) return

      const errorObj = (data && data.error) || data
      const parsed = extractErrorStack(errorObj, Severity.Normal)
      if (!parsed) return

      parsed.type = ErrorTypes.JAVASCRIPT_ERROR

      client.breadcrumb.push({
        type: BreadCrumbTypes.CODE_ERROR,
        category: client.breadcrumb.getCategory(BreadCrumbTypes.CODE_ERROR),
        data: parsed,
        level: Severity.Normal,
        time: parsed.time,
      })

      client.transport.send(parsed)
    },
  })
}

/**
 * 订阅资源加载错误（<img>/<script>/<link> 的 error 事件）。
 * 独立开关 silentResource（旧版被 silentError 连带静默且无法单独控制——已修复）。
 */
export function handleResourceError(client: MonitorClient): void {
  client.registry.subscribe({
    type: EventTypes.RESOURCE_ERROR_EVENT,
    id: 'browser.resource-error',
    callback: (data: ResourceErrorTarget) => {
      if (client.isSilent(EventTypes.RESOURCE_ERROR_EVENT)) return

      const parsed = resourceTransform(data)

      client.breadcrumb.push({
        type: BreadCrumbTypes.RESOURCE,
        category: client.breadcrumb.getCategory(BreadCrumbTypes.RESOURCE),
        data: parsed,
        level: Severity.Low,
        time: parsed.time,
      })

      client.transport.send(parsed)
    },
  })
}

/**
 * 订阅未捕获的 Promise rejection。
 */
export function handleUnhandledRejection(client: MonitorClient): void {
  client.registry.subscribe({
    type: EventTypes.UNHANDLEDREJECTION,
    id: 'browser.unhandledrejection',
    callback: (reason: unknown) => {
      if (client.isSilent(EventTypes.UNHANDLEDREJECTION)) return

      const source =
        reason instanceof Error
          ? reason
          : { name: 'unhandledrejection', message: stringifyReason(reason) }

      const parsed = extractErrorStack(source, Severity.Low)
      if (!parsed) return

      parsed.type = ErrorTypes.PROMISE_ERROR

      client.breadcrumb.push({
        type: BreadCrumbTypes.UNHANDLEDREJECTION,
        category: client.breadcrumb.getCategory(BreadCrumbTypes.UNHANDLEDREJECTION),
        data: parsed,
        level: Severity.Low,
        time: parsed.time,
      })

      client.transport.send(parsed)
    },
  })
}

/**
 * 把非 Error 的 reject 原因转成可读字符串。
 */
function stringifyReason(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason == null) return String(reason)
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

/**
 * 订阅 XHR / Fetch 请求事件（两条通道共用 dispatch）。
 * httpTransform 规范化后：所有请求进面包屑，
 * 仅失败请求（status===0 跨域/超时，或 status>=400）才上报为 FETCH_ERROR。
 *
 * filterXhrUrlRegExp 在此集中消费：命中则完全不监控该请求（敏感接口排除）。
 */
export function handleHttp(client: MonitorClient): void {
  const dispatch = (data: MonitorHttp): void => {
    const silent =
      data.type === HttpTypes.XHR
        ? client.isSilent(EventTypes.XHR)
        : client.isSilent(EventTypes.FETCH)
    if (silent) return

    // 敏感接口过滤（旧版配置只存不用——现在真正生效）
    const filter = client.options.filterXhrUrlRegExp
    if (filter && data.url && filter.test(data.url)) return

    const parsed = httpTransform(data)
    const isError = data.status === 0 || (data.status ?? 0) >= 400
    const crumbType = data.type === HttpTypes.XHR ? BreadCrumbTypes.XHR : BreadCrumbTypes.FETCH

    client.breadcrumb.push({
      type: crumbType,
      category: client.breadcrumb.getCategory(crumbType),
      data: parsed,
      level: isError ? Severity.Error : Severity.Info,
      time: data.time,
    })

    if (isError) {
      client.transport.send(parsed)
    }
  }

  client.registry.subscribe({
    type: EventTypes.XHR,
    id: 'browser.http-xhr',
    callback: dispatch,
  })
  client.registry.subscribe({
    type: EventTypes.FETCH,
    id: 'browser.http-fetch',
    callback: dispatch,
  })
}

/**
 * 订阅 console 调用 → 写入面包屑。
 */
export function handleConsoleEvent(client: MonitorClient): void {
  client.registry.subscribe({
    type: EventTypes.CONSOLE,
    id: 'browser.console',
    callback: (data: { level: string; args: unknown[] }) => {
      if (client.isSilent(EventTypes.CONSOLE)) return
      handleConsole(data, client.breadcrumb)
    },
  })
}

/**
 * 订阅 DOM 点击 → 写入面包屑（还原用户操作链）。
 */
export function handleDomEvent(client: MonitorClient): void {
  client.registry.subscribe({
    type: EventTypes.DOM,
    id: 'browser.dom-click',
    callback: (data: { category: string; data: string }) => {
      client.breadcrumb.push({
        type: BreadCrumbTypes.CLICK,
        category: client.breadcrumb.getCategory(BreadCrumbTypes.CLICK),
        data,
        level: Severity.Info,
        time: getTimestamp(),
      })
    },
  })
}

/**
 * 订阅路由变化 → 触发 onRouteChange 钩子 + 写入面包屑。
 */
export function handleHistoryEvent(client: MonitorClient): void {
  client.registry.subscribe({
    type: EventTypes.HISTORY,
    id: 'browser.history',
    callback: (data: { from: string; to: string }) => {
      const hook = client.options.onRouteChange
      if (typeof hook === 'function') {
        try {
          hook(data.from, data.to)
        } catch {
          // 用户钩子报错不影响采集流程
        }
      }

      client.breadcrumb.push({
        type: BreadCrumbTypes.ROUTE,
        category: client.breadcrumb.getCategory(BreadCrumbTypes.ROUTE),
        data,
        level: Severity.Info,
        time: getTimestamp(),
      })
    },
  })
}
