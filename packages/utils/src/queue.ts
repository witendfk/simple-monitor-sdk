import { _global } from './global'

export type voidFun = () => void

export class Queue {
  private micro: Promise<void> | null = null
  private stack: any[] = []
  private isFlushing = false

  constructor() {
    if (!('Promise' in _global)) return
    this.micro = Promise.resolve()
  }

  addFn(fn: voidFun): void {
    if (typeof fn !== 'function') return
    if (!('Promise' in _global)) {
      fn()
      return
    }
    this.stack.push(fn)
    if (!this.isFlushing) {
      this.isFlushing = true
      this.micro?.then(() => this.flushStack())
    }
  }

  clear() {
    this.stack = []
  }

  getStack() {
    return this.stack
  }

  flushStack(): void {
    const temp = this.stack.slice(0)
    this.stack.length = 0
    this.isFlushing = false
    for (let i = 0; i < temp.length; i++) {
      try {
        temp[i]()
      } catch {
        // 逐函数隔离：单个上报函数抛错不允许中断队列中其余请求，
        // 也不允许沿 micro.then 逃逸成 unhandled rejection（异步纪律）
      }
    }
  }
}
