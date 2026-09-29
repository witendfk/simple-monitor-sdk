/**
 * BatchSender —— 批量上报引擎（M2 可靠性核心，总纲 §七 M2）
 *
 * 职责：把准备好的 TransportDataType 按目标 dsn 分组缓冲，
 * 组装协议信封后经「fetch keepalive（主动期）/ sendBeacon（离场期）」发出；
 * 失败重试（指数退避 + Retry-After），重试耗尽落 IndexedDB 待重放。
 *
 * 状态机（替代旧 isUnloading 布尔标记）：
 *   active ── pagehide/hidden ──> leaving ── pageshow/visible ──> active
 *   - active：缓冲 + 定时/定量批量 flush，fetch(keepalive) + gzip
 *   - leaving：立即同步 flush，sendBeacon 通道（浏览器保证送达，不带 gzip——
 *     beacon 无法 await 异步压缩，换取「必达」；服务端 raw body 解析兼容 text/plain）
 *
 * 设计取舍（面试讲点）：
 *  - at-least-once：先落库/重试，成功才移除；重复由服务端 fingerprint 幂等消化
 *  - 重试只对网络错误/5xx；4xx（除 429/503）是协议/权限问题，重试无意义，直接丢弃
 *  - 缓冲上限：单 dsn 组超过 MAX_BATCH_EVENTS 强制 flush，防止异常风暴下内存膨胀
 */
import { LIMITS, type TransportEnvelope } from '@simple-monitor/protocol'
import { logger } from '@simple-monitor/utils'
import { EnvelopeCache } from './idbCache'

/** 批量参数（总纲 §七 M2：5s 或 10 条触发 flush） */
export const FLUSH_INTERVAL_MS = 5000
export const MAX_BATCH_EVENTS = 10
/** 单组缓冲硬上限（超过立即 flush，防内存膨胀） */
export const MAX_BUFFERED_PER_DSN = 100
/** 重试参数 */
const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 500
const BACKOFF_JITTER_MS = 250
const RETRY_AFTER_CAP_MS = 10_000
/** gzip 最小阈值：小载荷压缩得不偿失 */
const GZIP_MIN_BYTES = 1024
/** keepalive 载荷安全上限（浏览器硬限 64KB，留余量） */
const KEEPALIVE_MAX_BYTES = 60_000

export type ChannelState = 'active' | 'leaving'

export interface BatchSenderDeps {
  /** 由 TransportData 提供自身状态组装信封（auth/session/context/事件转换） */
  buildEnvelope: (
    payloads: Array<{ dsn: string; data: any }>
  ) => { dsn: string; envelope: TransportEnvelope } | null
  /** 每信封发送前回调（兼容 configReportUrl 钩子：返回 falsy 取消发送） */
  beforeSend?: (envelope: TransportEnvelope, dsn: string) => string | false | void
  /** 发送结果回调（观测/测试用） */
  onSendResult?: (ok: boolean, dsn: string, eventCount: number) => void
  /** 离线缓存（可注入替身；缺省 IndexedDB 实现，node/SSR 自动 no-op） */
  cache?: EnvelopeCache
}

export class BatchSender {
  private state: ChannelState = 'active'
  /** dsn → 缓冲的载荷（保持到达顺序） */
  private groups = new Map<string, Array<{ dsn: string; data: any }>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 进行中的 flush（防并发重复发送同一组） */
  private inFlight = new Set<string>()
  private readonly cache: EnvelopeCache

  constructor(private readonly deps: BatchSenderDeps) {
    this.cache = deps.cache ?? new EnvelopeCache()
  }

  /** 当前通道状态（测试观测用） */
  getState(): ChannelState {
    return this.state
  }

  /** 当前缓冲的事件数（测试观测用） */
  get bufferedCount(): number {
    let n = 0
    this.groups.forEach((g) => (n += g.length))
    return n
  }

  /**
   * 入队一条已就绪的载荷。leaving 状态下直接同步走 beacon。
   */
  add(dsn: string, data: any): void {
    if (!dsn) return
    if (this.state === 'leaving') {
      this.flushLeaving([{ dsn, data }])
      return
    }
    let group = this.groups.get(dsn)
    if (!group) {
      group = []
      this.groups.set(dsn, group)
    }
    group.push({ dsn, data })
    // 第二个条件当前不可达（10 < 100），防御性保留：MAX_BATCH_EVENTS 调大时兜底防内存膨胀
    if (group.length >= MAX_BATCH_EVENTS || group.length >= MAX_BUFFERED_PER_DSN) {
      void this.flush(dsn)
      return
    }
    this.scheduleTimer()
  }

  /** 通道进入离场：立即同步 flush（beacon），不再缓冲 */
  markLeaving(): void {
    if (this.state === 'leaving') return
    this.state = 'leaving'
    this.clearTimer()
    const all: Array<{ dsn: string; data: any }> = []
    this.groups.forEach((g) => all.push(...g))
    this.groups.clear()
    this.flushLeaving(all)
  }

  /** 通道恢复活跃（pageshow/visible：复位旧版粘滞 bug 的正确形态） */
  markActive(): void {
    this.state = 'active'
  }

  private scheduleTimer(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flushAll()
    }, FLUSH_INTERVAL_MS)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 立即 flush 全部组（定时器到期 / 测试 / destroy 前） */
  async flushAll(): Promise<void> {
    const dsns = [...this.groups.keys()]
    await Promise.all(dsns.map((dsn) => this.flush(dsn)))
  }

  /** flush 指定组：组装信封 → 发送（fetch + 重试 + 离库兜底） */
  async flush(dsn: string): Promise<void> {
    if (this.state === 'leaving') {
      const group = this.groups.get(dsn)
      if (group) {
        this.groups.delete(dsn)
        this.flushLeaving(group)
      }
      return
    }
    if (this.inFlight.has(dsn)) return
    const group = this.groups.get(dsn)
    if (!group || group.length === 0) return
    this.inFlight.add(dsn)
    this.groups.delete(dsn)
    this.clearTimer()
    try {
      // 其他组仍在缓冲时必须重挂定时器：定时器是全局共享的，
      // 否则 A 组 flush 会吃掉 B 组唯一的触发源（滞留到下一个事件进来）
      if (this.groups.size > 0) {
        this.scheduleTimer()
      }
      await this.sendWithRetry(dsn, group)
    } catch (error) {
      // 定时器触发的 flush 是 fire-and-forget（void），任何异常必须就地消化——
      // 监控 SDK 自身不允许产生 unhandled rejection（CI 事故同类纪律）
      logger.error('flush error:', error)
      this.deps.onSendResult?.(false, dsn, group.length)
    } finally {
      this.inFlight.delete(dsn)
    }
  }

  /** 离场同步通道：beacon 逐信封发送（不缓冲不重试，浏览器保证尽力送达） */
  private flushLeaving(payloads: Array<{ dsn: string; data: any }>): void {
    if (payloads.length === 0) return
    // 本方法在 pagehide/visibilitychange 监听器内同步执行：任何异常都会以
    // uncaught error 形式打进宿主页面——buildEnvelope / 钩子 / 序列化全部就地防护
    let built: { dsn: string; envelope: TransportEnvelope } | null
    try {
      built = this.deps.buildEnvelope(payloads)
    } catch (error) {
      logger.error('buildEnvelope error (leaving):', error)
      return
    }
    if (!built) return
    let url: string | false | void = built.dsn
    if (typeof this.deps.beforeSend === 'function') {
      try {
        url = this.deps.beforeSend(built.envelope, built.dsn)
      } catch (error) {
        logger.error('beforeSend hook error:', error)
        return
      }
    }
    if (!url) return
    let json: string
    try {
      json = JSON.stringify(built.envelope)
    } catch (error) {
      // 循环引用等序列化失败：降级为「SDK 自有安全字段」重建的最小信封
      // （auth/session 无用户数据必可序列化；浅展开不行——嵌套循环引用会原样保留）
      logger.error('envelope serialize error (leaving), fallback to minimal envelope:', error)
      try {
        const env = built.envelope
        const minimal = {
          protocolVersion: env.protocolVersion,
          sentAt: env.sentAt,
          auth: env.auth,
          session: env.session,
          context: { page: env.context?.page ?? '' },
          events: [],
        }
        json = JSON.stringify(minimal)
      } catch {
        return
      }
    }
    try {
      const beacon = (globalThis as any)?.navigator?.sendBeacon
      if (typeof beacon === 'function' && beacon.call(globalThis.navigator, url, json)) {
        this.deps.onSendResult?.(true, built.dsn, payloads.length)
        return
      }
    } catch (error) {
      logger.error('sendBeacon error:', error)
    }
    // beacon 不可用/被拒：同步兜底无法保证送达，落库待重放
    void this.cache.save(String(url), json)
    this.deps.onSendResult?.(false, built.dsn, payloads.length)
  }

  /** 主动期发送：gzip（可用时）→ fetch keepalive → 指数退避重试 → IndexedDB 兜底 */
  private async sendWithRetry(
    dsn: string,
    payloads: Array<{ dsn: string; data: any }>
  ): Promise<void> {
    // 超过协议单信封上限时分片
    for (let i = 0; i < payloads.length; i += LIMITS.maxEventsPerEnvelope) {
      const slice = payloads.slice(i, i + LIMITS.maxEventsPerEnvelope)
      await this.sendSlice(dsn, slice)
    }
  }

  private async sendSlice(dsn: string, payloads: Array<{ dsn: string; data: any }>): Promise<void> {
    // buildEnvelope / JSON.stringify 消费用户数据（beforeDataReport 钩子可注入任意对象，
    // 循环引用会让 stringify 抛错）——任何同步异常在此就地消化
    let built: { dsn: string; envelope: TransportEnvelope } | null
    try {
      built = this.deps.buildEnvelope(payloads)
    } catch (error) {
      logger.error('buildEnvelope error:', error)
      this.deps.onSendResult?.(false, dsn, payloads.length)
      return
    }
    if (!built) return
    let url: string | false | void = built.dsn
    if (typeof this.deps.beforeSend === 'function') {
      try {
        url = this.deps.beforeSend(built.envelope, built.dsn)
      } catch (error) {
        logger.error('beforeSend hook error:', error)
        return
      }
    }
    if (!url) return

    let json: string
    try {
      json = JSON.stringify(built.envelope)
    } catch (error) {
      // 循环引用等序列化失败：丢弃本批并告警，不让异常逃逸成 unhandled rejection
      logger.error('envelope serialize error:', error)
      this.deps.onSendResult?.(false, dsn, payloads.length)
      return
    }
    const { body, gzip } = await maybeGzip(json)
    const contentType = gzip ? 'application/gzip' : 'application/json'
    // fetch keepalive 有 64KB body 硬限，超出直接 reject 且会被误判为网络错误
    // → 重试 → 落库 → replay 再 reject 的死循环；大信封主动放弃 keepalive（主动期无需必达）
    const bodySize = typeof body === 'string' ? body.length : body.byteLength
    const keepalive = bodySize <= KEEPALIVE_MAX_BYTES

    let attempt = 0
    let backoff = BACKOFF_BASE_MS
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1
      try {
        const res = await fetch(url as string, {
          method: 'POST',
          headers: { 'Content-Type': contentType },
          body: body as BodyInit,
          keepalive,
        })
        if (res.ok) {
          this.deps.onSendResult?.(true, dsn, payloads.length)
          return
        }
        // 429/503 限流：尊重 Retry-After；其余 4xx 直接放弃（重试无意义）
        if (res.status === 429 || res.status === 503) {
          const ra = Number(res.headers.get('retry-after') || 0)
          const waitMs =
            Number.isFinite(ra) && ra > 0
              ? Math.min(ra * 1000, RETRY_AFTER_CAP_MS)
              : backoff + Math.random() * BACKOFF_JITTER_MS
          await sleep(waitMs)
          backoff *= 2
          continue
        }
        if (res.status >= 500) {
          await sleep(backoff + Math.random() * BACKOFF_JITTER_MS)
          backoff *= 2
          continue
        }
        logger.error(`上报被服务端拒绝（${res.status}），丢弃本批 ${payloads.length} 条`)
        this.deps.onSendResult?.(false, dsn, payloads.length)
        return
      } catch {
        // 网络错误：退避后重试
        await sleep(backoff + Math.random() * BACKOFF_JITTER_MS)
        backoff *= 2
      }
    }
    // 重试耗尽：落库待重放
    await this.cache.save(String(url), json)
    this.deps.onSendResult?.(false, dsn, payloads.length)
  }

  /** 启动时重放离线缓存（fire-and-forget，失败静默——下次启动再试） */
  async replay(): Promise<void> {
    try {
      const cached = await this.cache.popAll()
      for (const item of cached) {
        try {
          await fetch(item.dsn, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: item.json,
            keepalive: item.json.length <= KEEPALIVE_MAX_BYTES,
          })
        } catch {
          // 仍不可达：放弃本轮，不回写（避免僵尸数据滚雪球）
        }
      }
    } catch {
      /* 缓存不可用 */
    }
  }

  /** 测试与销毁用：丢弃缓冲 */
  reset(): void {
    this.clearTimer()
    this.groups.clear()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** CompressionStream gzip（可用且载荷足够大时）；失败降级原文 */
async function maybeGzip(json: string): Promise<{ body: string | Uint8Array; gzip: boolean }> {
  const CS = (globalThis as any).CompressionStream
  if (!CS || json.length < GZIP_MIN_BYTES) return { body: json, gzip: false }
  try {
    const stream = new Blob([json]).stream().pipeThrough(new CS('gzip'))
    const buf = await new Response(stream).arrayBuffer()
    return { body: new Uint8Array(buf), gzip: true }
  } catch {
    return { body: json, gzip: false }
  }
}
