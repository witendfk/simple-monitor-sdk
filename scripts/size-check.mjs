#!/usr/bin/env node
/**
 * 体积门禁（M7，总纲「全链路 gzip 体积 CI 预算」）：
 *
 * 各发布包 ESM 入口（dist/index.mjs）的 gzip 字节数 vs 预算表。
 * 预算 = 2026-09-30 实测基线 × 1.2（向上取整），写死且**只降不增**——
 * 产物体积优化后应同步下调预算，防止体积回涨被余量掩盖。
 *
 * 用法：pnpm build && pnpm size（CI 在 build 之后执行，超限 exit 1 判红）
 */
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 预算表（字节）：包名 → gzip 上限。基线 2026-09-30 实测，×1.2 取整 */
const BUDGETS = {
  types: 2554, // 基线 2129
  utils: 6762, // 基线 5635
  shared: 662, // 基线 552
  protocol: 3829, // 基线 3191
  core: 21446, // 基线 17872
  browser: 7366, // 基线 6139
  web: 1276, // 基线 1064
  'web-performance': 10231, // 基线 8526
  vue: 836, // 基线 697
  react: 1023, // 基线 853
}

let failed = false
let total = 0
const rows = []
for (const [pkg, budget] of Object.entries(BUDGETS)) {
  const file = resolve(root, `packages/${pkg}/dist/index.mjs`)
  let actual
  try {
    actual = gzipSync(readFileSync(file)).length
  } catch {
    console.error(`✗ ${pkg}: 产物缺失（${file}），先 pnpm build`)
    process.exit(1)
  }
  total += actual
  const ok = actual <= budget
  if (!ok) failed = true
  rows.push(`${ok ? '✓' : '✗'} ${pkg.padEnd(18)} gzip ${String(actual).padStart(6)} B / 预算 ${String(budget).padStart(6)} B`)
}

console.log(rows.join('\n'))
console.log(`\n合计 gzip ${total} B`)
if (failed) {
  console.error('\n体积门禁未通过：存在超预算包。请优化体积或将预算下调（只降不增，不许上调）。')
  process.exit(1)
}
console.log('体积门禁通过（预算 = 基线×1.2，只降不增）')
