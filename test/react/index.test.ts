import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ErrorTypes, BreadCrumbTypes } from '@simple-monitor/types'
import { errorBoundaryReport } from '../../packages/react/src/index'
import { transportData, breadcrumb } from '@simple-monitor/core'

describe('errorBoundaryReport', () => {
  beforeEach(() => {
    vi.spyOn(transportData, 'send').mockResolvedValue(undefined)
    breadcrumb.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('封装为 REACT_ERROR 并上报，从 componentStack 提取组件名', () => {
    errorBoundaryReport(new Error('render boom'), {
      componentStack: '\n    in MyComp\n    in App',
    })

    expect(transportData.send).toHaveBeenCalledTimes(1)
    const sent = (transportData.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.type).toBe(ErrorTypes.REACT_ERROR)
    expect(sent.componentName).toBe('MyComp')
  })

  it('推入 React 类型面包屑', () => {
    errorBoundaryReport(new Error('x'), { componentStack: '\n    in C' })
    expect(breadcrumb.getStack().some((b) => b.type === BreadCrumbTypes.REACT)).toBe(true)
  })

  it('无 componentStack 时 componentName 为 anonymous', () => {
    errorBoundaryReport(new Error('x'))
    const sent = (transportData.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.componentName).toBe('anonymous')
  })

  it('React 18+ componentStack（at Xxx 格式）也能提取组件名', () => {
    errorBoundaryReport(new Error('render boom'), {
      componentStack: '\n    at MyComp\n    at App\n    at div',
    })
    const sent = (transportData.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.componentName).toBe('MyComp')
  })

  it('componentStack 无匹配组件名时降级 anonymous', () => {
    errorBoundaryReport(new Error('x'), { componentStack: 'no component here' })
    const sent = (transportData.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.componentName).toBe('anonymous')
  })
})
