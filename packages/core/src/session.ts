/**
 * 会话与用户标识（M2，总纲 §4.1 前置字段）
 *
 * - sessionId：sessionStorage 级，关标签页失效——会话分析的主键；
 * - trackerId：localStorage 级，跨会话稳定——用户级聚合的维度。
 *
 * 存储不可用（隐私模式/SSR/测试 node 环境）逐级降级到内存，
 * 语义退化为「进程内会话」，不抛错不阻断上报。
 */
import { generateUUID, getGlobal } from '@simple-monitor/utils'

const SESSION_KEY = 'simple-monitor-session-id'
const TRACKER_KEY = 'simple-monitor-tracker-id'

function safeStorage(storage: Storage | null, fn: (s: Storage) => void): void {
  try {
    if (storage) fn(storage)
  } catch {
    /* 隐私模式/禁用 cookie：忽略 */
  }
}

export class SessionManager {
  private memorySessionId: string | null = null
  private memoryTrackerId: string | null = null

  private localStorage(): Storage | null {
    const g = getGlobal<any>()
    return g?.localStorage ?? null
  }

  private sessionStorage(): Storage | null {
    const g = getGlobal<any>()
    return g?.sessionStorage ?? null
  }

  /** 会话标识：sessionStorage → 内存降级 */
  getSessionId(): string {
    let id: string | null = null
    safeStorage(this.sessionStorage(), (s) => {
      id = s.getItem(SESSION_KEY)
      if (!id) {
        id = generateUUID()
        s.setItem(SESSION_KEY, id)
      }
    })
    if (id) return id
    if (!this.memorySessionId) this.memorySessionId = generateUUID()
    return this.memorySessionId
  }

  /** 用户标识：localStorage → 内存降级（原 transportData.getDefaultTrackerId 逻辑迁移） */
  getTrackerId(): string {
    let id: string | null = null
    safeStorage(this.localStorage(), (s) => {
      id = s.getItem(TRACKER_KEY)
      if (!id) {
        id = generateUUID()
        s.setItem(TRACKER_KEY, id)
      }
    })
    if (id) return id
    if (!this.memoryTrackerId) this.memoryTrackerId = generateUUID()
    return this.memoryTrackerId
  }
}
