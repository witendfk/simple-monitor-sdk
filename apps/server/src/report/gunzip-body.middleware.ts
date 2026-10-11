/**
 * gzip 信封解压中间件（§3.3 P1 有界解析）：SDK 对 >1KB 的信封走 CompressionStream
 * （Content-Type application/gzip），在 JSON 解析前解包。压缩输入 1MB / 解压输出 2MB
 * 双向设限防高压缩比炸弹——全 '0' 载荷压缩比可达千倍，gunzipSync 全量缓冲且无输出上限，
 * 1MB 输入可解出 GB 级内存。正常信封解压后远小于此（JSON body 本身上限 256KB）。
 *
 * 独立成模块供 e2e 与 main.ts 共用（测试必须真实执行到生产同款中间件）。
 */
import type express from 'express'
import zlib from 'node:zlib'

export const GZIP_INPUT_MAX = 1024 * 1024
export const GUNZIP_OUTPUT_MAX = 2 * 1024 * 1024

export function gunzipBody(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const contentType = req.headers['content-type'] ?? ''
  if (!String(contentType).includes('application/gzip')) {
    next()
    return
  }
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > GZIP_INPUT_MAX) {
      overflow = true
      res.status(413).json({ error: 'gzip body too large' })
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (overflow) return
    // 流式解压并累计输出字节数，超限即毁流回 413
    const input = Buffer.concat(chunks)
    const gunzip = zlib.createGunzip()
    const out: Buffer[] = []
    let outSize = 0
    let rejected = false
    const reject413 = (): void => {
      if (rejected || res.headersSent) return
      rejected = true
      res.status(413).json({ error: 'decompressed body too large' })
    }
    gunzip.on('data', (c: Buffer) => {
      if (rejected) return
      outSize += c.length
      if (outSize > GUNZIP_OUTPUT_MAX) {
        gunzip.destroy()
        reject413()
        return
      }
      out.push(c)
    })
    gunzip.on('end', () => {
      if (rejected) return
      try {
        req.body = JSON.parse(Buffer.concat(out).toString('utf8'))
        // body-parser 看到 _body=true 会跳过读取（此时流已被本中间件消费完）
        ;(req as express.Request & { _body?: boolean })._body = true
        next()
      } catch {
        res.status(400).json({ error: 'invalid gzip body' })
      }
    })
    gunzip.on('error', () => {
      // 覆盖两类：损坏载荷的解压错误、超限 destroy 引发的 premature close
      if (!rejected && !res.headersSent) res.status(400).json({ error: 'invalid gzip body' })
    })
    gunzip.end(input)
  })
}
