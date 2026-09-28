/**
 * IndexedDB 离线信封缓存（M2 可靠性引擎）
 *
 * 发送最终失败（重试耗尽/断网）的信封落库，下次 init 时重放。
 * 上限 50 条（丢最老）、过期 3 天——离线缓存是尽力而为的补偿，不是持久队列。
 * indexedDB 不可用（SSR/测试 node/隐私模式）整体 no-op，调用方无感。
 */

/** 单条缓存信封 */
export interface CachedEnvelope {
  dsn: string
  /** JSON 序列化后的完整信封 */
  json: string
  /** 入库时间 ms（过期判定） */
  sentAt: number
}

const DB_NAME = 'simple-monitor'
const STORE = 'pending-envelopes'
const MAX_ENTRIES = 50
const EXPIRE_MS = 3 * 24 * 60 * 60 * 1000

export class EnvelopeCache {
  private dbPromise: Promise<IDBDatabase | null> | null = null

  private available(): boolean {
    try {
      return typeof indexedDB !== 'undefined'
    } catch {
      return false
    }
  }

  private open(): Promise<IDBDatabase | null> {
    if (!this.available()) return Promise.resolve(null)
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open(DB_NAME, 1)
          req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(STORE)) {
              db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
            }
          }
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
    }
    return this.dbPromise
  }

  private tx<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T | null> {
    return this.open().then(
      (db) =>
        new Promise<T | null>((resolve) => {
          if (!db) return resolve(null)
          try {
            const transaction = db.transaction(STORE, mode)
            const request = fn(transaction.objectStore(STORE))
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => resolve(null)
          } catch {
            resolve(null)
          }
        })
    )
  }

  /** 落库一条；超过上限时丢最老一条再写入（容量小，代价可忽略） */
  async save(dsn: string, json: string): Promise<void> {
    const count = (await this.tx('readonly', (s) => s.count())) ?? 0
    if (count >= MAX_ENTRIES) {
      await this.deleteOldest()
    }
    await this.tx('readwrite', (s) => s.add({ dsn, json, sentAt: Date.now() }))
  }

  /** 删除最老一条（keyPath 自增主键 id 最小者） */
  private async deleteOldest(): Promise<void> {
    const db = await this.open()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const transaction = db.transaction(STORE, 'readwrite')
        const store = transaction.objectStore(STORE)
        const req = store.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (cursor) {
            cursor.delete()
          }
          // 只删最老一条：无论是否命中，结束
        }
        req.onerror = () => resolve()
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  /** 取出全部有效缓存并清空（重放语义：取走即删，失败不重复堆积） */
  async popAll(): Promise<CachedEnvelope[]> {
    const all = (await this.tx<CachedEnvelope[]>('readonly', (s) => s.getAll())) ?? []
    await this.clear()
    const now = Date.now()
    return all.filter((e) => now - e.sentAt < EXPIRE_MS)
  }

  async clear(): Promise<void> {
    await this.tx('readwrite', (s) => s.clear())
  }

  async count(): Promise<number> {
    return (await this.tx('readonly', (s) => s.count())) ?? 0
  }
}
