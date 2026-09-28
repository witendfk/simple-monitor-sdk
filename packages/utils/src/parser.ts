import { ErrorTypes } from '@simple-monitor/types'
import { getLocationHref } from './helpers'
import { getTimestamp } from './time'
import { interceptStr } from './string'
import { mask } from './mask'
import { ReportDataType, Severity } from '@simple-monitor/types'

/**
 * 返回包含 id、class、innerText 的标签字符串（面包屑点击采集用）。
 * innerText 经过脱敏（手机号/身份证/卡号/凭证）+ 截断（50 字符）——
 * 点击的元素文本常含用户敏感数据，原文上报是隐私事故（旧实现原样输出却注释"脱敏"，已修复）。
 * @param target html节点
 */
export function htmlElementAsString(target: HTMLElement): string | null {
  const tagName = target.tagName.toLowerCase()
  if (tagName === 'body') {
    return null
  }
  let classNames = target.classList.value
  classNames = classNames !== '' ? ` class="${classNames}"` : ''
  const id = target.id ? ` id="${target.id}"` : ''
  const innerText = target.innerText
  return `<${tagName}${id}${classNames !== '' ? classNames : ''}>${interceptStr(mask(innerText || ''), 50)}</${tagName}>`
}

/**
 * 将地址字符串转换成对象
 * @returns 返回一个对象
 */
export function parseUrlToObj(url: string): {
  host?: string
  path?: string
  protocol?: string
  relative?: string
} {
  if (!url) {
    return {}
  }

  const match = url.match(/^(([^:/?#]+):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/)

  if (!match) {
    return {}
  }

  const query = match[6] || ''
  const fragment = match[8] || ''
  return {
    host: match[4] || undefined,
    path: match[5] || undefined,
    protocol: match[2] || undefined,
    relative: (match[5] || '') + query + fragment,
  }
}

/**
 * 解析error的stack，并返回args、column、line、func、url:
 * @param ex
 * @param level
 */
export function extractErrorStack(ex: any, level: Severity): ReportDataType | null {
  const normal = {
    time: getTimestamp(),
    url: getLocationHref(),
    name: ex.name,
    level,
    message: ex.message,
  }
  if (typeof ex.stack === 'undefined' || !ex.stack) {
    return normal
  }

  const chrome =
      /^\s*at (.*?) ?\(((?:file|https?|blob|chrome-extension|native|eval|webpack|<anonymous>|[a-z]:|\/).*?)(?::(\d+))?(?::(\d+))?\)?\s*$/i,
    gecko =
      /^\s*(.*?)(?:\((.*?)\))?(?:^|@)((?:file|https?|blob|chrome|webpack|resource|\[native).*?|[^@]*bundle)(?::(\d+))?(?::(\d+))?\s*$/i,
    winjs =
      /^\s*at (?:((?:\[object object\])?.+) )?\(?((?:file|ms-appx|https?|webpack|blob):.*?):(\d+)(?::(\d+))?\)?\s*$/i,
    // Used to additionally parse URL/line/column from eval frames
    geckoEval = /(\S+) line (\d+)(?: > eval line \d+)* > eval/i,
    chromeEval = /\((\S*)(?::(\d+))(?::(\d+))\)/,
    lines = ex.stack.split('\n'),
    stack = []

  let submatch, parts, element

  for (let i = 0, j = lines.length; i < j; ++i) {
    if ((parts = chrome.exec(lines[i]))) {
      const isNative = parts[2] && parts[2].indexOf('native') === 0 // start of line
      const isEval = parts[2] && parts[2].indexOf('eval') === 0 // start of line
      if (isEval && (submatch = chromeEval.exec(parts[2]))) {
        // throw out eval line/column and use top-most line/column number
        parts[2] = submatch[1] // url
        parts[3] = submatch[2] // line
        parts[4] = submatch[3] // column
      }
      element = {
        url: !isNative ? parts[2] : null,
        func: parts[1] || ErrorTypes.UNKNOWN_FUNCTION,
        args: isNative ? [parts[2]] : [],
        line: parts[3] ? +parts[3] : null,
        column: parts[4] ? +parts[4] : null,
      }
    } else if ((parts = winjs.exec(lines[i]))) {
      element = {
        url: parts[2],
        func: parts[1] || ErrorTypes.UNKNOWN_FUNCTION,
        args: [],
        line: +parts[3],
        column: parts[4] ? +parts[4] : null,
      }
    } else if ((parts = gecko.exec(lines[i]))) {
      const isEval = parts[3] && parts[3].indexOf(' > eval') > -1
      if (isEval && (submatch = geckoEval.exec(parts[3]))) {
        parts[3] = submatch[1]
        parts[4] = submatch[2]
        ;(parts as any)[5] = null // no column when eval
      } else if (i === 0 && !parts[5] && typeof ex.columnNumber !== 'undefined') {
        // FireFox uses this awesome columnNumber property for its top frame
        // Also note, Firefox's column number is 0-based and everything else expects 1-based,
        // so adding 1
        // NOTE: this hack doesn't work if top-most frame is eval
        stack[0].column = ex.columnNumber + 1
      }
      element = {
        url: parts[3],
        func: parts[1] || ErrorTypes.UNKNOWN_FUNCTION,
        args: parts[2] ? parts[2].split(',') : [],
        line: parts[4] ? +parts[4] : null,
        column: parts[5] ? +parts[5] : null,
      }
    } else {
      continue
    }

    if (!element.func && element.line) {
      element.func = ErrorTypes.UNKNOWN_FUNCTION
    }

    stack.push(element)
  }

  if (!stack.length) {
    // 堆栈逐行都匹配不上（minify/格式异常）：降级上报 normal（仅 message/url），
    // 不丢弃——与「完全没有 stack 字段」的分支保持一致，避免丢失 message 线索。
    // 上游 handleError 仍会因 parsed 存在而走 send；若需更严格过滤可改回 null。
    return normal
  }
  return {
    ...normal,
    stack: stack,
  }
}
