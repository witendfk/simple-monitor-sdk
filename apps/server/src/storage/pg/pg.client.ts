/**
 * Postgres 连接池（M7.5 P1 元数据域）：PG_URL 在位时由 app.module 创建，
 * 元数据各 store 共用一个池。连接参数：postgres://user:pass@host:5432/db。
 */
import { Pool } from 'pg'

export function createPgPool(pgUrl: string): Pool {
  return new Pool({
    connectionString: pgUrl,
    max: 10,
    // 池内空闲客户端 30s 释放，防长连接被中间设备静默掐断后占用
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
}
