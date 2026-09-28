import { describe, it, expect, beforeEach } from 'vitest'
import { breadcrumb } from '@simple-monitor/core'
import { BreadCrumbTypes } from '@simple-monitor/types'
import type { BreadcrumbPushData } from '@simple-monitor/types'

function crumb(data: unknown, time?: number): BreadcrumbPushData {
  return {
    type: BreadCrumbTypes.CLICK,
    category: 'user',
    data,
    level: 'Info',
    time,
  } as BreadcrumbPushData
}

describe('Breadcrumb', () => {
  beforeEach(() => {
    breadcrumb.clear()
    breadcrumb.maxBreadcrumbs = 10
    ;(breadcrumb as { beforePushBreadcrumb: unknown }).beforePushBreadcrumb = null
  })

  it('push 存入栈', () => {
    breadcrumb.push(crumb('a'))
    expect(breadcrumb.getStack().length).toBe(1)
  })

  it('超过 maxBreadcrumbs 时丢弃最早记录（环形缓冲）', () => {
    breadcrumb.maxBreadcrumbs = 3
    for (let i = 0; i < 5; i++) breadcrumb.push(crumb(i, i))

    const stack = breadcrumb.getStack()
    expect(stack.length).toBe(3)
    // 最早的 i=0,1 被丢弃，保留 i=2,3,4
    expect(stack[0].data).toBe(2)
    expect(stack[2].data).toBe(4)
  })

  it('clear 清空栈', () => {
    breadcrumb.push(crumb('a'))
    breadcrumb.clear()
    expect(breadcrumb.getStack().length).toBe(0)
  })

  it('未提供 time 时自动填充时间戳', () => {
    breadcrumb.push(crumb('a'))
    expect(typeof breadcrumb.getStack()[0].time).toBe('number')
  })

  it('按 time 升序排序', () => {
    breadcrumb.maxBreadcrumbs = 10
    breadcrumb.push(crumb('late', 30))
    breadcrumb.push(crumb('early', 10))
    breadcrumb.push(crumb('mid', 20))

    const times = breadcrumb.getStack().map((b) => b.time)
    expect(times).toEqual([10, 20, 30])
  })

  it('beforePushBreadcrumb 返回 falsy 时取消 push', () => {
    ;(breadcrumb as { beforePushBreadcrumb: unknown }).beforePushBreadcrumb = () => null
    breadcrumb.push(crumb('a'))
    expect(breadcrumb.getStack().length).toBe(0)
  })
})
