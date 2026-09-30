/* eslint-disable @typescript-eslint/no-explicit-any -- 测试替身与脏数据构造场景豁免（对齐 batchSenderHardening 先例） */
/**
 * webhook SSRF 防护回归（§3.8 P0）：字面值判定 + 连接时 DNS 复核 + 重定向逐跳。
 * 用例来源于 2026-09-30 实证绕过向量（localhost. 尾点 / v4-mapped / ULA / 链路本地）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { isSafeWebhookUrl, isHostAllowedLiteral } from '../src/alert/webhook-url'
import { isWebhookUrlConnectAllowed } from '../src/alert/webhook-net'
import { FetchWebhookSender } from '../src/alert/alert-engine'

describe('isSafeWebhookUrl 字面值判定（首轮实证绕过向量回归）', () => {
  it('2026-09-30 实证的 4 个绕过向量现已拒绝', () => {
    expect(isSafeWebhookUrl('http://localhost.:6379/')).toBe(false)
    expect(isSafeWebhookUrl('http://[::ffff:127.0.0.1]:6379/')).toBe(false)
    expect(isSafeWebhookUrl('http://[::ffff:7f00:1]/')).toBe(false)
    expect(isSafeWebhookUrl('http://[fd00::1]/')).toBe(false)
    expect(isSafeWebhookUrl('http://[fe80::1]/')).toBe(false)
    expect(isSafeWebhookUrl('http://[::1]/')).toBe(false)
  })
  it('既有基准不变：localhost/127/10/169.254/172.16-31/192.168/非 http(s) 拒绝', () => {
    for (const url of [
      'http://localhost:6379/',
      'http://127.0.0.1:8080/',
      'http://10.0.0.5/',
      'http://169.254.169.254/latest/meta-data/',
      'http://172.20.1.1/',
      'http://192.168.1.1/',
      'file:///etc/passwd',
      'gopher://host/',
    ]) {
      expect(isSafeWebhookUrl(url), url).toBe(false)
    }
  })
  it('合法值不误伤：公网 IPv4/IPv6/域名放行', () => {
    for (const url of [
      'https://hooks.example.com/x',
      'http://8.8.8.8/hook',
      'http://[2001:db8::1]/hook',
    ]) {
      expect(isSafeWebhookUrl(url), url).toBe(true)
    }
  })
  it('URL 内置 IPv4 规范化：变体写法仍按真实地址判定（拒）', () => {
    // WHATWG URL 把它们规范化为 127.0.0.1（2026-09-30 实证：变体不逃逸）
    expect(isSafeWebhookUrl('http://127.1/')).toBe(false)
    expect(isSafeWebhookUrl('http://2130706433/')).toBe(false)
  })
  it('allowPrivate 放开私网但保留协议白名单', () => {
    expect(isSafeWebhookUrl('http://localhost:3000/hook', true)).toBe(true)
    expect(isSafeWebhookUrl('file:///etc/passwd', true)).toBe(false)
  })
  it('isHostAllowedLiteral：域名只拒本地名，IP 归属不在此判定', () => {
    expect(isHostAllowedLiteral('hooks.example.com')).toBe(true)
    expect(isHostAllowedLiteral('evil.local')).toBe(false)
    expect(isHostAllowedLiteral('metadata.internal')).toBe(false)
  })
})

describe('isWebhookUrlConnectAllowed（DNS 解析后复核）', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  async function withLookup(address: string): Promise<(url: string) => Promise<boolean>> {
    vi.resetModules()
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn().mockResolvedValue({ address, family: address.includes(':') ? 6 : 4 }),
    }))
    const mod = await import('../src/alert/webhook-net')
    return mod.isWebhookUrlConnectAllowed
  }

  it('公网域名解析到私网地址 → 拒绝（DNS 重绑定第一道防线）', async () => {
    const check = await withLookup('10.1.2.3')
    expect(await check('http://rebind.example.com/hook')).toBe(false)
  })
  it('公网域名解析到公网地址 → 放行', async () => {
    const check = await withLookup('93.184.216.34')
    expect(await check('http://public.example.com/hook')).toBe(true)
  })
  it('域名解析失败 → 按拒绝处理（宁可误拒）', async () => {
    vi.resetModules()
    vi.doMock('node:dns/promises', () => ({
      lookup: vi.fn().mockRejectedValue(new Error('ENOTFOUND')),
    }))
    const mod = await import('../src/alert/webhook-net')
    expect(await mod.isWebhookUrlConnectAllowed('http://nonexistent.example/')).toBe(false)
  })
  it('IP 字面量不经 DNS 直接判定', async () => {
    expect(await isWebhookUrlConnectAllowed('http://169.254.169.254/')).toBe(false)
    expect(await isWebhookUrlConnectAllowed('http://8.8.8.8/')).toBe(true)
  })
})

describe('FetchWebhookSender 重定向逐跳校验', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function redirectResponse(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } })
  }

  it('每跳都过地址校验：重定向到私网目标被拒（自动跟随不可绕过检查）', async () => {
    const checked: string[] = []
    const sender = new FetchWebhookSender({
      resolveAllowed: async (url) => {
        checked.push(url)
        return !url.includes('internal.example')
      },
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(redirectResponse('http://internal.example/hook'))
        .mockResolvedValue(new Response(null, { status: 200 }))
    )
    await expect(sender.send('http://public.example/hook', { a: 1 })).rejects.toThrow('blocked')
    expect(checked).toEqual(['http://public.example/hook', 'http://internal.example/hook'])
  })

  it('正常公网链路：非重定向响应直接成功', async () => {
    const sender = new FetchWebhookSender({ resolveAllowed: async () => true })
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sender.send('http://public.example/hook', { a: 1 })).resolves.toBeUndefined()
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
  })

  it('重定向超过上限报错', async () => {
    const sender = new FetchWebhookSender({ resolveAllowed: async () => true })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => redirectResponse('http://loop.example/next'))
    )
    await expect(sender.send('http://public.example/hook', { a: 1 })).rejects.toThrow('redirects')
  })
})
