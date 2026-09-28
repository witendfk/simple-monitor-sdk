import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ErrorTypes, Severity } from '@simple-monitor/types'
import { log } from '@simple-monitor/core'
import { transportData } from '@simple-monitor/core'
import { breadcrumb } from '@simple-monitor/core'

describe('log (external)', () => {
  beforeEach(() => {
    vi.spyOn(transportData, 'send').mockResolvedValue(undefined)
    breadcrumb.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('组装 LOG_ERROR 并经 transportData.send 上报', () => {
    log({ message: '支付失败', tag: 'payment' })

    expect(transportData.send).toHaveBeenCalledTimes(1)
    const sent = (transportData.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.type).toBe(ErrorTypes.LOG_ERROR)
    expect(sent.message).toBe('支付失败')
    expect(sent.customTag).toBe('payment')
    expect(sent.name).toBe('Monitor.log')
  })

  it('缺省时 message=emptyMsg、level=Critical、type=LOG_ERROR', () => {
    log({})

    const sent = (transportData.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.message).toBe('emptyMsg')
    expect(sent.level).toBe(Severity.Critical)
    expect(sent.type).toBe(ErrorTypes.LOG_ERROR)
  })

  it('推入一条面包屑', () => {
    const before = breadcrumb.getStack().length
    log({ message: 'hi' })
    expect(breadcrumb.getStack().length).toBe(before + 1)
  })

  it('ex 为 Error 时提取其 name/message', () => {
    log({ message: 'x', ex: new Error('boom') })

    const sent = (transportData.send as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.name).toBe('Error')
    expect(sent.message).toBe('boom')
  })
})
