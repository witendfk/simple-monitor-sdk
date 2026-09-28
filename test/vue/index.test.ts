import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ErrorTypes, EventTypes, BreadCrumbTypes } from '@simple-monitor/types'
import { getDefaultMonitorClient, transportData, breadcrumb } from '@simple-monitor/core'
import { MonitorVue } from '../../packages/vue/src/index'

const client = getDefaultMonitorClient()

describe('MonitorVue', () => {
  beforeEach(() => {
    vi.spyOn(transportData, 'send').mockResolvedValue(undefined)
    breadcrumb.clear()
    client.setSilent(EventTypes.VUE, false)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    client.setSilent(EventTypes.VUE, false)
  })

  it('install 重写 errorHandler，捕获错误为 VUE_ERROR 并带上组件名', () => {
    const app = { config: {} as Record<string, unknown> }
    MonitorVue.install(app)
    expect(typeof app.config?.errorHandler).toBe('function')
    ;(app.config!.errorHandler as (err: unknown, instance: unknown, info: string) => unknown)(
      new Error('render boom'),
      { $options: { name: 'MyComp' } },
      'render'
    )

    expect(transportData.send).toHaveBeenCalledTimes(1)
    const sent = (transportData.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.type).toBe(ErrorTypes.VUE_ERROR)
    expect(sent.componentName).toBe('MyComp')
    expect(sent.errorInfo).toBe('render')
  })

  it('组件名拿不到时记 anonymous', () => {
    const app = { config: {} as Record<string, unknown> }
    MonitorVue.install(app)
    ;(app.config!.errorHandler as (err: unknown, instance: unknown, info: string) => unknown)(
      new Error('x'),
      null,
      'setup'
    )

    const sent = (transportData.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.componentName).toBe('anonymous')
  })

  it('推入 Vue 类型面包屑', () => {
    const app = { config: {} as Record<string, unknown> }
    MonitorVue.install(app)
    ;(app.config!.errorHandler as (err: unknown, instance: unknown, info: string) => unknown)(
      new Error('x'),
      { $options: { name: 'C' } },
      'render'
    )

    expect(breadcrumb.getStack().some((b) => b.type === BreadCrumbTypes.VUE)).toBe(true)
  })

  it('silentVue 时不上报', () => {
    client.setSilent(EventTypes.VUE, true)
    const app = { config: {} as Record<string, unknown> }
    MonitorVue.install(app)
    ;(app.config!.errorHandler as (err: unknown, instance: unknown, info: string) => unknown)(
      new Error('x'),
      null,
      'render'
    )

    expect(transportData.send).not.toHaveBeenCalled()
  })

  it('保留用户既有的 errorHandler', () => {
    const userHandler = vi.fn(() => 'user-result')
    const app = { config: { errorHandler: userHandler } }
    MonitorVue.install(app)

    const err = new Error('x')
    const ret = (
      app.config!.errorHandler as (err: unknown, instance: unknown, info: string) => unknown
    )(err, null, 'render')

    expect(userHandler).toHaveBeenCalledWith(err, null, 'render')
    expect(ret).toBe('user-result')
  })

  it('无 config 时 install 安全跳过', () => {
    expect(() => MonitorVue.install({} as never)).not.toThrow()
  })
})
