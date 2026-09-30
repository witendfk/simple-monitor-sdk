import {
  BreadCrumbTypes,
  BreadCrumbCategory,
  BreadcrumbPushData,
  InitOptions,
  IBreadcrumb,
} from '@simple-monitor/types'
import { validateOption, getTimestamp, silentConsoleScope } from '@simple-monitor/utils'
import { LIMITS } from '@simple-monitor/protocol'

/**
 * 面包屑用户行为栈（M1 类化，ADR-1）
 *
 * 环形缓冲：超出 maxBreadcrumbs 丢最早记录。
 * 旧实现的 push 后全量 sort 是历史包袱——记录本就按到达顺序追加（时间几乎单调），
 * 现改为：仅当发现时间倒序时做一次插入修正，常态 O(1)。
 */
export class Breadcrumb implements IBreadcrumb {
  maxBreadcrumbs = 10
  beforePushBreadcrumb: unknown = null
  stack: BreadcrumbPushData[] = []

  push(data: BreadcrumbPushData): void {
    if (typeof this.beforePushBreadcrumb === 'function') {
      let result: BreadcrumbPushData | null = null
      const beforePushBreadcrumb = this.beforePushBreadcrumb
      silentConsoleScope(() => {
        result = beforePushBreadcrumb(this, data)
      })
      if (!result) return
      this.immediatePush(result)
      return
    }
    this.immediatePush(data)
  }

  immediatePush(data: BreadcrumbPushData): void {
    data.time ??= getTimestamp()
    if (this.stack.length >= this.maxBreadcrumbs) {
      this.stack.shift()
    }
    this.stack.push(data)
    // 只修正局部倒序（时钟回拨 / 异步乱序到达），常态无额外开销
    const n = this.stack.length
    if (n >= 2 && (this.stack[n - 2].time || 0) > (this.stack[n - 1].time || 0)) {
      this.stack.sort((a, b) => (a.time || 0) - (b.time || 0))
    }
  }

  shift(): boolean {
    return this.stack.shift() !== undefined
  }

  clear(): void {
    this.stack = []
  }

  getStack(): BreadcrumbPushData[] {
    return this.stack
  }

  getCategory(type: BreadCrumbTypes) {
    switch (type) {
      case BreadCrumbTypes.XHR:
      case BreadCrumbTypes.FETCH:
        return BreadCrumbCategory.HTTP
      case BreadCrumbTypes.CLICK:
      case BreadCrumbTypes.ROUTE:
      case BreadCrumbTypes.TAP:
      case BreadCrumbTypes.TOUCHMOVE:
        return BreadCrumbCategory.USER
      case BreadCrumbTypes.CUSTOMER:
      case BreadCrumbTypes.CONSOLE:
        return BreadCrumbCategory.DEBUG
      case BreadCrumbTypes.UNHANDLEDREJECTION:
      case BreadCrumbTypes.CODE_ERROR:
      case BreadCrumbTypes.RESOURCE:
      case BreadCrumbTypes.VUE:
      case BreadCrumbTypes.REACT:
      default:
        return BreadCrumbCategory.EXCEPTION
    }
  }

  bindOptions(options: InitOptions = {}): void {
    const { maxBreadcrumbs, beforePushBreadcrumb } = options
    if (validateOption(maxBreadcrumbs, 'maxBreadcrumbs', 'number')) {
      // 钳制到协议上限：超限面包屑会让信封被服务端整批拒收（400 连坐同批事件）
      this.maxBreadcrumbs = Math.max(1, Math.min(LIMITS.maxBreadcrumbs, maxBreadcrumbs!))
    }
    if (validateOption(beforePushBreadcrumb, 'beforePushBreadcrumb', 'function')) {
      this.beforePushBreadcrumb = beforePushBreadcrumb
    }
  }
}
