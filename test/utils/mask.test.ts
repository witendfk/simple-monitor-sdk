// @vitest-environment jsdom
/**
 * 隐私脱敏测试（M1 收尾批次）：mask 纯函数 + 三入口接入行为
 * （DOM innerText / console args / HTTP 请求体）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mask, setPrivacyMaskEnabled, htmlElementAsString } from '@simple-monitor/utils'
import { BreadCrumbTypes } from '@simple-monitor/types'
import { MonitorClient, handleConsole } from '@simple-monitor/core'
import { setupReplace } from '../../packages/browser/src/setupReplace'

describe('mask 纯函数', () => {
  beforeEach(() => setPrivacyMaskEnabled(true))

  it('手机号遮蔽', () => {
    expect(mask('用户 13812345678 登录')).toBe('用户 [phone] 登录')
  })
  it('身份证遮蔽（含 X 结尾）', () => {
    expect(mask('证件号110101199003077578')).toBe('证件号[id]')
    expect(mask('证件号11010119900307757X')).toBe('证件号[id]')
  })
  it('银行卡等 16-19 位长号遮蔽', () => {
    expect(mask('卡号6222020200112233445')).toBe('卡号[card]')
  })
  it('凭证遮蔽（Bearer / token= / password=）', () => {
    expect(mask('Authorization: Bearer abc.def-123')).toContain('[credential]')
    expect(mask('token=eyJhbGciOi.')).toContain('[credential]')
    expect(mask('password: p@ssw0rd!')).toContain('[credential]')
  })
  it('普通文本不受影响', () => {
    expect(mask('正常的日志内容 v1.2.3')).toBe('正常的日志内容 v1.2.3')
    // 版本号/时间戳等短数字不误伤
    expect(mask('2026-09-28 12:30:00')).toBe('2026-09-28 12:30:00')
  })
  it('开关关闭时原样返回（业务显式担责）', () => {
    setPrivacyMaskEnabled(false)
    expect(mask('13812345678')).toBe('13812345678')
    setPrivacyMaskEnabled(true)
  })
})

describe('入口 1：DOM 序列化 innerText 脱敏 + 截断', () => {
  it('点击元素文本中的手机号被遮蔽，长文本被截断 50 字符', () => {
    const el = document.createElement('button')
    el.id = 'pay'
    el.innerText = '确认支付 13812345678，' + '长'.repeat(80)
    const s = htmlElementAsString(el)
    expect(s).not.toContain('13812345678')
    expect(s).toContain('[phone]')
    expect(s!.length).toBeLessThan(120)
  })
})

describe('入口 2：console args 脱敏 + 截断', () => {
  it('console 打印的凭证/用户数据进面包屑前被遮蔽', () => {
    const client = new MonitorClient()
    client.breadcrumb.clear()
    handleConsole(
      { level: 'log', args: ['登录成功', { token: 'eyJhbGciOiJIUzI1Nix', phone: '13812345678' }] },
      client.breadcrumb
    )
    const crumb = client.breadcrumb.getStack().find((b) => b.type === BreadCrumbTypes.CONSOLE)
    expect(crumb).toBeDefined()
    const serialized = JSON.stringify(crumb!.data)
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1Nix')
    expect(serialized).not.toContain('13812345678')
    expect(serialized).toContain('[credential]')
    expect(serialized).toContain('[phone]')
  })
})

describe('入口 3：HTTP 请求体脱敏（FakeXHR 走真实包装链）', () => {
  class FakeXHR {
    readyState = 0
    status = 0
    responseText = ''
    responseType: string = ''
    headers: Record<string, string> = {}
    method = ''
    url = ''
    private listener: ((e: Event) => void) | null = null
    open(method: string, url: string) {
      this.method = method
      this.url = url
      this.readyState = 1
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v
    }
    send() {}
    addEventListener(type: string, fn: (e: Event) => void) {
      if (type === 'readystatechange') this.listener = fn
    }
    fire(status = 500) {
      this.readyState = 4
      this.status = status
      this.listener?.(new Event('readystatechange'))
    }
  }

  it('XHR 请求体中的卡号/手机号进面包屑前被遮蔽', () => {
    ;(globalThis as any).XMLHttpRequest = FakeXHR
    const client = new MonitorClient()
    client.init({ dsn: 'http://localhost/report', apikey: 'k' } as any)
    setupReplace(client)
    client.breadcrumb.clear()

    const xhr = new FakeXHR()
    xhr.open('POST', 'http://api.example.com/pay')
    // 包装后的 send 会采集 args[0] 作为 reqData（脱敏+截断后存 monitor_xhr）
    xhr.send('card=6222020200112233445&phone=13812345678')
    xhr.fire(500)

    const crumb = client.breadcrumb.getStack().find((b) => b.type === BreadCrumbTypes.XHR)
    expect(crumb).toBeDefined()
    const serialized = JSON.stringify(crumb!.data)
    expect(serialized).not.toContain('6222020200112233445')
    expect(serialized).not.toContain('13812345678')
    expect(serialized).toContain('[card]')
    expect(serialized).toContain('[phone]')
  })
})
