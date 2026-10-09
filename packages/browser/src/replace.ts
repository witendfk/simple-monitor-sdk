/**
 * 采集器（replace）
 *
 * 所有「包装/监听原生 API」的同质逻辑集中在此，只负责：
 * 拿到原生事件 → 解析出数据 → client.registry 分发。
 * 不做 transform / send —— 那是 handleEvents.ts 的职责。
 *
 * M1：全部采集函数接收 client（读静默开关/配置、写追踪头），不再依赖全局单例。
 * 幂等：由 browser/init 的 client.initialized 守卫保证「只装载一次」；
 * replaceOld 的 __monitor_wrapped 标记防同方法被其他库重复包装。
 */

import { EventTypes, HttpTypes } from '@simple-monitor/types'
import {
  on,
  replaceOld,
  getTimestamp,
  interceptStr,
  mask,
  throttle,
  htmlElementAsString,
  getLocationHref,
} from '@simple-monitor/utils'
import type { MonitorClient } from '@simple-monitor/core'
import type { ResourceErrorTarget, MonitorHttp, MonitorXMLHttpRequest } from '@simple-monitor/types'

/**
 * 判断 event.target 是否为资源元素（img/script/link 等）。
 * 资源加载失败时，target 是元素本身且不含 error 信息；代码错误时 target 是 window。
 */
function isResourceTarget(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement
}

/**
 * 监听全局 error 事件，分流「代码错误」与「资源错误」。
 * 两者使用独立静默开关（ERROR / RESOURCE_ERROR_EVENT），互不连带。
 */
export function listenError(client: MonitorClient): void {
  on(
    window,
    'error',
    (e: Event) => {
      const target = e.target as EventTarget | null

      // 资源错误：target 是元素
      if (isResourceTarget(target)) {
        if (client.isSilent(EventTypes.RESOURCE_ERROR_EVENT)) return
        const element = target as HTMLElement
        client.registry.trigger(EventTypes.RESOURCE_ERROR_EVENT, {
          target: element,
          src: (element as HTMLImageElement).src || element.getAttribute('src') || '',
          href: element.getAttribute('href') || '',
          localName: element.localName,
        } as ResourceErrorTarget)
        return
      }

      // 代码错误：走通用 error 通道
      if (client.isSilent(EventTypes.ERROR)) return
      client.registry.trigger(EventTypes.ERROR, e)
    },
    true // 捕获阶段 —— 资源错误必须在此阶段捕获
  )
}

/**
 * 监听未捕获的 Promise rejection。
 */
export function listenUnhandledRejection(client: MonitorClient): void {
  on(window, 'unhandledrejection', (e: Event) => {
    if (client.isSilent(EventTypes.UNHANDLEDREJECTION)) return
    const reason = (e as PromiseRejectionEvent).reason
    client.registry.trigger(EventTypes.UNHANDLEDREJECTION, reason)
  })
}

/**
 * 包装 XMLHttpRequest：open 记录 method/url/traceId，send 记请求体，
 * 请求完成（readyState=4）时触发采集。
 *
 * 追踪头注入（ADR-7）：enableTraceId + includeHttpUrlTraceIdRegExp 命中时，
 * open 后注入 traceparent（字段名可配），并把同一个 traceId 记入 monitor_xhr——
 * 请求头与上报数据对齐，服务端才能串起前后端链路（修复旧版「只生成不注入」）。
 *
 * 防自循环：open 时用 isSdkTransportUrl 判定是否为上报地址，
 * 是则在 monitor_xhr.isSdkUrl 打标，完成时跳过分发。
 */
export function xhrReplace(client: MonitorClient): void {
  if (typeof window === 'undefined' || typeof XMLHttpRequest === 'undefined') return
  const proto = XMLHttpRequest.prototype

  replaceOld(
    proto,
    'open',
    (originalOpen) =>
      function (this: MonitorXMLHttpRequest, ...args: any[]): void {
        const method = args[0]
        const rawUrl = args[1]
        const urlStr = typeof rawUrl === 'string' ? rawUrl : String(rawUrl ?? '')
        this.monitor_xhr = {
          type: HttpTypes.XHR,
          method,
          url: urlStr,
          sTime: getTimestamp(),
          traceId: undefined as unknown as string,
          isSdkUrl: client.transport.isSdkTransportUrl(urlStr),
        }
        originalOpen.apply(this, args)
        if (!this.monitor_xhr.isSdkUrl) {
          try {
            client.options.resolveTraceId(urlStr, (fieldName, traceId) => {
              this.setRequestHeader(fieldName, traceId)
              this.monitor_xhr!.traceId = traceId
            })
          } catch {
            /* 响应已发出等场景无法设头，忽略 */
          }
        }
      }
  )

  replaceOld(
    proto,
    'send',
    (originalSend) =>
      function (this: MonitorXMLHttpRequest, ...args: any[]): void {
        const monitorXhr = this.monitor_xhr
        if (monitorXhr) {
          const body = args[0]
          monitorXhr.reqData = typeof body === 'string' ? interceptStr(mask(body), 2048) : ''
          this.addEventListener('readystatechange', () => {
            if (this.readyState === 4) {
              completeXhr(this, client)
            }
          })
        }
        originalSend.apply(this, args)
      }
  )
}

/**
 * 安全读取响应文本：业务设置 responseType='json'|'blob'|'arraybuffer' 时
 * 访问 responseText 会抛 InvalidStateError——监控不允许向宿主抛异常（总纲 §3.2）。
 * 统一截断到 2048 字符。
 */
function safeResponseText(xhr: XMLHttpRequest): string {
  try {
    const responseType = xhr.responseType
    if (responseType === '' || responseType === 'text') {
      return interceptStr(mask(String(xhr.responseText ?? '')), 2048)
    }
    return `[${responseType}]`
  } catch {
    return ''
  }
}

/** XHR 完成时补全 status/耗时/响应体，按 isSdkUrl 与静默开关决定是否分发。 */
function completeXhr(xhr: MonitorXMLHttpRequest, client: MonitorClient): void {
  try {
    const monitorXhr = xhr.monitor_xhr
    if (!monitorXhr) return
    monitorXhr.status = xhr.status
    monitorXhr.elapsedTime = getTimestamp() - (monitorXhr.sTime ?? 0)
    monitorXhr.time = monitorXhr.sTime
    monitorXhr.responseText = safeResponseText(xhr)
    if (monitorXhr.isSdkUrl) return
    if (client.isSilent(EventTypes.XHR)) return
    client.registry.trigger(EventTypes.XHR, monitorXhr)
  } catch {
    // 采集异常不允许波及业务请求回调
  }
}

/**
 * 请求体脱敏统一出口：成功/失败两条采集分支共用同一函数，
 * 防止复制漂移再次漏掉 mask（隐私纪律：HTTP body 入信封前必脱敏+截断）。
 */
function sanitizeReqData(body: unknown): string {
  return interceptStr(mask(typeof body === 'string' ? body : ''), 2048)
}

/**
 * 包装 window.fetch：记录请求信息，响应/失败时触发采集。
 * 二进制/大响应跳过 body 读取（clone().text() 会把整个 body 拉进内存）。
 */
export function fetchReplace(client: MonitorClient): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return

  replaceOld(
    window,
    'fetch',
    (originalFetch) =>
      function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = resolveFetchUrl(input)
        const sTime = getTimestamp()
        const method = resolveFetchMethod(input, init)
        // 防自循环：SDK 自身上报（BatchSender 主动期走 fetch）不再采集——
        // 与 xhr 通道的 isSdkUrl 语义对齐（§3.7：上报请求混入面包屑 + dsn
        // 不可用时的自反馈放大）
        if (client.transport.isSdkTransportUrl(url)) {
          return (originalFetch as (...a: unknown[]) => Promise<Response>).apply(window, [
            input,
            init,
          ])
        }

        // 追踪头注入（ADR-7）：复制请求头后写入，保持业务原 init 不被修改
        let traceId: string | undefined
        let requestInit = init
        try {
          client.options.resolveTraceId(url, (fieldName, tid) => {
            traceId = tid
            const headers = new Headers(init?.headers)
            headers.set(fieldName, tid)
            requestInit = { ...init, headers }
          })
        } catch {
          /* Headers 不可用等极端环境：跳过注入 */
        }

        return (originalFetch as (...a: any[]) => Promise<Response>)
          .apply(window, [input, requestInit])
          .then(
            (res: Response) => {
              readResponseBody(res, (text) => {
                triggerFetch(client, {
                  type: HttpTypes.FETCH,
                  url,
                  method,
                  status: res.status,
                  reqData: sanitizeReqData(requestInit?.body),
                  sTime,
                  elapsedTime: getTimestamp() - sTime,
                  time: sTime,
                  responseText: text,
                  traceId,
                })
              })
              return res
            },
            (err: unknown) => {
              triggerFetch(client, {
                type: HttpTypes.FETCH,
                url,
                method,
                status: 0,
                reqData: sanitizeReqData(requestInit?.body),
                sTime,
                elapsedTime: getTimestamp() - sTime,
                time: sTime,
                responseText: '',
                traceId,
              })
              throw err
            }
          )
      }
  )
}

/**
 * 按需读取响应体：二进制类型 / 超大响应直接跳过（记占位标记），
 * 其余 clone 后异步读取并截断——不阻塞业务消费原响应。
 */
function readResponseBody(res: Response, consume: (text: string) => void): void {
  try {
    const contentType = res.headers.get('content-type') || ''
    const contentLength = Number(res.headers.get('content-length') || 0)
    const isBinary =
      /^(image|video|audio|font)\//.test(contentType) ||
      contentType.includes('octet-stream') ||
      contentType.includes('event-stream') // SSE：克隆读会缓冲整条流，跳过
    if (isBinary || (contentLength > 0 && contentLength > 512 * 1024)) {
      consume('[skipped:binary-or-large]')
      return
    }
    res
      .clone()
      .text()
      .then((text: string) => consume(interceptStr(mask(text), 2048)))
      .catch(() => {
        /* body 已被业务消费/流错误：放弃采集 */
      })
  } catch {
    /* headers 不可用等极端环境 */
  }
}

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return (input as Request).url || ''
}

function resolveFetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return String(init.method)
  if (typeof input !== 'string' && !(input instanceof URL) && input.method) {
    return input.method
  }
  return 'GET'
}

function triggerFetch(client: MonitorClient, data: MonitorHttp): void {
  if (client.isSilent(EventTypes.FETCH)) return
  client.registry.trigger(EventTypes.FETCH, data)
}

/**
 * 包装 console.log/info/warn/error/debug：每次调用先分发到面包屑，
 * 再执行原方法（保证业务日志正常输出）。
 * 受 silentConsole 控制（handler 侧检查）；是否真正写入面包屑由 handleConsole 决定。
 */
export function consoleReplace(client: MonitorClient): void {
  if (typeof console === 'undefined' || !console) return
  const levels = ['log', 'info', 'warn', 'error', 'debug']
  levels.forEach((level) => {
    replaceOld(
      console,
      level,
      (original) =>
        function (...args: unknown[]): void {
          client.registry.trigger(EventTypes.CONSOLE, { level, args })
          if (typeof original === 'function') {
            original.apply(console, args)
          }
        }
    )
  })
}

/**
 * DOM 点击采集：节流后把目标节点序列化为字符串 → 面包屑（还原用户操作链）。
 * 节流间隔取 options.throttleDelayTime（默认 200ms，与配置默认值一致）。
 */
export function domReplace(client: MonitorClient): void {
  if (typeof document === 'undefined') return
  const handler = throttle((e: Event): void => {
    if (client.isSilent(EventTypes.DOM)) return
    const target = e.target as HTMLElement
    const html = htmlElementAsString(target)
    if (html) {
      client.registry.trigger(EventTypes.DOM, { category: 'click', data: html })
    }
  }, client.options.throttleDelayTime)
  on(document, 'click', handler as EventListener, true)
}

/**
 * 路由采集：重写 history.pushState/replaceState + 监听 hashchange/popstate，
 * 统一触发 onRouteChange 钩子并写入面包屑。
 */
let lastHref = ''

export function historyReplace(client: MonitorClient): void {
  if (typeof window === 'undefined' || typeof window.history === 'undefined') return
  lastHref = getLocationHref()

  const wrap = (method: 'pushState' | 'replaceState'): void => {
    replaceOld(
      history,
      method,
      (original) =>
        function (...args: any[]): void {
          const url = args[2]
          original.apply(history, args)
          triggerRoute(client, url)
        }
    )
  }
  wrap('pushState')
  wrap('replaceState')

  on(window, 'hashchange', (e) => {
    const ev = e as HashChangeEvent
    // 不传 from：与 pushState/popstate 统一走 lastHref 去重——修复
    // 「pushState(#/b) 已触发 HISTORY 且 lastHref 已更新，随后的 hashchange
    // 再以 oldURL 触发一次」的双面包屑（vue-router hash 模式必现，§3.7）
    triggerRoute(client, ev.newURL)
  })
  on(window, 'popstate', () => {
    triggerRoute(client, getLocationHref())
  })
}

/** 规范化目标地址（补全相对路径），去重相同路由，再按静默开关决定是否分发。 */
function triggerRoute(client: MonitorClient, to?: string | null, from?: string | null): void {
  const fromUrl = from || lastHref
  let toUrl = to || getLocationHref()
  if (toUrl && !/^https?:\/\//.test(toUrl)) {
    try {
      toUrl = new URL(toUrl, getLocationHref()).href
    } catch {
      /* 解析失败保持原值 */
    }
  }
  if (fromUrl === toUrl) {
    lastHref = toUrl
    return
  }
  lastHref = toUrl
  if (client.isSilent(EventTypes.HISTORY)) return
  client.registry.trigger(EventTypes.HISTORY, { from: fromUrl, to: toUrl })
}
