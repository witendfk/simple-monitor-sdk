// @vitest-environment jsdom
/**
 * P2 回归：destroy 丢弃批量缓冲（销毁后不再有任何发送行为）
 */
import { describe, it, expect } from 'vitest'
import { ErrorTypes } from '@simple-monitor/types'
import { MonitorClient, clearDedup } from '@simple-monitor/core'

describe('client.destroy 清理批量缓冲', () => {
  it('销毁后缓冲归零、disabled 置位', async () => {
    clearDedup()
    const client = new MonitorClient()
    client.init({ dsn: 'http://localhost/report', apikey: 'k' })
    await client.transport.send({
      type: ErrorTypes.LOG_ERROR,
      message: 'pending',
      level: 'Low',
      url: 'http://x/',
    })
    expect(client.transport.bufferedCount).toBe(1)

    client.destroy()
    expect(client.transport.bufferedCount).toBe(0)
    expect(client.options.disabled).toBe(true)
  })
})
