// @vitest-environment jsdom
/**
 * 隐私脱敏测试（M1 收尾批次）：mask 纯函数 + 三入口接入行为
 * （DOM innerText / console args / HTTP 请求体）+ 出口兜底（maskDeep / stripUrlQuery）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  mask,
  maskDeep,
  stripUrlQuery,
  setPrivacyMaskEnabled,
  htmlElementAsString,
} from '@simple-monitor/utils'
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

describe('stripUrlQuery（PV / 成功请求 URL 的出口策略）', () => {
  it('绝对 URL 剥 query 与 hash，保留 origin+pathname', () => {
    expect(stripUrlQuery('https://a.com/p?token=abc&id=1#sec')).toBe('https://a.com/p')
  })
  it('相对路径剥 query（PV 的 pathname+search 形态）', () => {
    expect(stripUrlQuery('/list?page=2&q=x#top')).toBe('/list')
  })
  it('无 query/hash 原样返回；非字符串原样返回', () => {
    expect(stripUrlQuery('/detail/42')).toBe('/detail/42')
    expect(stripUrlQuery('')).toBe('')
    expect(stripUrlQuery(undefined as unknown as string)).toBe(undefined)
  })
})

describe('maskDeep（信封出口兜底）', () => {
  beforeEach(() => setPrivacyMaskEnabled(true))

  it('嵌套字符串遮蔽：props 里的手机号/JWT 无原值', () => {
    const out = maskDeep({
      props: { phone: '13812345678', jwt: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def' },
    })
    const s = JSON.stringify(out)
    expect(s).not.toContain('13812345678')
    expect(s).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(s).toContain('[phone]')
    expect(s).toContain('[credential]')
  })
  it('数值/布尔原样保留（13 位时间戳不被数字串规则误伤）', () => {
    const out = maskDeep({ time: 1727568000000, ok: true, score: 0.5 }) as Record<string, unknown>
    expect(out.time).toBe(1727568000000)
    expect(out.ok).toBe(true)
    expect(out.score).toBe(0.5)
  })
  it('标识键保留：traceId / errorId / apiKey 不被数字串规则破坏', () => {
    const traceId = '1234567890abcdef1234567890abcdef'
    const out = maskDeep({
      traceId,
      apiKey: 'ak-01',
      child: { errorId: 'abc123456789012' },
    }) as Record<string, unknown>
    expect(out.traceId).toBe(traceId)
    expect(out.apiKey).toBe('ak-01')
    expect((out.child as Record<string, unknown>).errorId).toBe('abc123456789012')
  })
  it('敏感值键整值遮蔽：{ pwd } 这类无文本特征的裸值靠键名识别', () => {
    const out = maskDeep({ pwd: 'hunter2', Password: 'p@ss', note: 'keep me' }) as Record<
      string,
      unknown
    >
    expect(out.pwd).toBe('[credential]')
    expect(out.Password).toBe('[credential]')
    expect(out.note).toBe('keep me')
    // 数值/布尔不受键名影响（walk 只对字符串做键名遮蔽）
    const mixed = maskDeep({ token: 123, pass: false }) as Record<string, unknown>
    expect(mixed.token).toBe(123)
    expect(mixed.pass).toBe(false)
  })
  it('幂等：已脱敏结构再走一遍结果不变（出口与入口双层调用安全）', () => {
    const once = maskDeep({ a: '13812345678', note: 'token=abc' }) as Record<string, unknown>
    const twice = maskDeep(once) as Record<string, unknown>
    expect(twice).toEqual(once)
  })
  it('先 mask 后截断：超限字符串截断到 maxString 且不漏原值', () => {
    const long = 'token=' + 'a'.repeat(5000)
    const out = maskDeep({ v: long }, { maxString: 100 }) as Record<string, string>
    expect(out.v.length).toBeLessThanOrEqual(120)
    expect(out.v).toContain('[credential]')
    expect(out.v).not.toContain('a'.repeat(5000))
  })
  it('不改变入参对象（缓冲中的载荷可复用重建信封）', () => {
    const input = { props: { phone: '13812345678' } }
    maskDeep(input)
    expect((input.props as Record<string, unknown>).phone).toBe('13812345678')
  })
  it('深度与容量上限（防超深/超宽结构拖垮出口）', () => {
    const deep = { a: { b: { c: { d: { e: '13812345678' } } } } }
    expect(JSON.stringify(maskDeep(deep, { maxDepth: 3 }))).toContain('[truncated]')
    expect(maskDeep({ arr: [1, 2, 3, 4, 5] }, { maxArray: 2 })).toEqual({ arr: [1, 2] })
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
