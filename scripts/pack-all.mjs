#!/usr/bin/env node
/**
 * 统一打包出口：把 packages/* 的发布产物（tgz）收拢到 <root>/release/。
 *
 * - 自动跳过 private 包（apps/*）；
 * - 每次先清空 release/ 旧产物（防版本混淆）；
 * - 产物即真实发布物（pnpm pack 会把 workspace:* 替换为真实版本），
 *   可直接 `npm i <tgz>` 在任意项目本地验证。
 *
 * 用法：pnpm pack:all（内含依赖的 build 请先单独跑或用 pnpm release 链路）
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'

const root = resolve(process.cwd())
if (basename(root) !== 'simple-monitor-sdk' && !existsSync(resolve(root, 'pnpm-workspace.yaml'))) {
  console.error('[pack:all] 请在仓库根目录运行')
  process.exit(1)
}

const outDir = resolve(root, 'release')
if (existsSync(outDir)) {
  for (const f of readdirSync(outDir)) {
    if (f.endsWith('.tgz')) rmSync(resolve(outDir, f))
  }
} else {
  mkdirSync(outDir)
}

const manifests = readdirSync(resolve(root, 'packages'))
  .map((name) => resolve(root, 'packages', name))
  .filter((dir) => statSync(dir).isDirectory() && existsSync(resolve(dir, 'package.json')))
  .map((dir) => resolve(dir, 'package.json'))

let packed = 0
for (const manifest of manifests) {
  const pkg = JSON.parse(readFileSync(manifest, 'utf-8'))
  if (pkg.private) continue
  const dir = resolve(manifest, '..')
  execSync(`pnpm pack --pack-destination "${outDir}"`, { cwd: dir, stdio: 'pipe' })
  console.log(`packed ${pkg.name}@${pkg.version} → release/${basename(pkg.name)}-*.tgz`)
  packed += 1
}

console.log(`\n[pack:all] ${packed} packages → ${outDir}`)
for (const f of readdirSync(outDir).sort()) console.log('  ' + f)
