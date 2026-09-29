/**
 * 隐私修复回归测试：page URL 脱敏（第四入口）
 */
import { describe, it, expect } from 'vitest'
import { sanitizePageUrl, mask } from '@simple-monitor/utils'
import { toErrorEvent } from '@simple-monitor/core'

describe('sanitizePageUrl', () => {
  it('绝对 URL：保留 origin+pathname，剥离 query/hash', () => {
    expect(sanitizePageUrl('http://x.com/pay?token=abc&uid=1')).toBe('http://x.com/pay')
    expect(sanitizePageUrl('http://x.com/list?page=2')).toBe('http://x.com/list')
    expect(sanitizePageUrl('http://x.com/app#/detail/123?token=abc')).toBe('http://x.com/app')
  })

  it('非法/相对 URL 降级 mask（凭证不外泄）', () => {
    expect(sanitizePageUrl('/detail?token=abc')).toContain('[credential]')
    expect(sanitizePageUrl('')).toBe('')
  })
})

describe('error 事件 URL 隐私（envelope 层）', () => {
  it('error.page 剥离 query；http.url 保留 query 但凭证被 mask', () => {
    const event = toErrorEvent({
      type: 'LOG_ERROR',
      message: 'm',
      level: 'Low',
      url: 'http://x.com/pay?orderid=1234567890123',
      request: { method: 'GET', url: 'http://api.x.com/orders?token=secret123', status: 500 },
      response: { status: 500 },
    } as any)
    expect(event.error.page).toBe('http://x.com/pay')
    expect(event.error.http?.url).toContain('[credential]')
    expect(event.error.http?.url).not.toContain('secret123')
  })

  it('修复对照：mask 之前的敏感 URL 不会被原样上报', () => {
    const url = 'http://api.x.com/u?phone=13812345678'
    expect(mask(url)).not.toContain('13812345678')
  })
})
