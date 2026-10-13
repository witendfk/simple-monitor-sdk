/**
 * 密码哈希（M7.5 P3 权限分离）：node:crypto scrypt——零外部依赖（DIP 纪律：
 * server 不引 bcrypt/argon2）。存储格式 `scrypt$<salt hex>$<hash hex>`。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const KEY_LEN = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEY_LEN)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

/** 非法格式/参数不符一律 false（不抛出），比较用 timingSafeEqual 防时序侧信道 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, saltHex, hashHex] = stored.split('$')
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
    const expected = Buffer.from(hashHex, 'hex')
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
