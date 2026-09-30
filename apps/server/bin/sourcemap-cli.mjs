#!/usr/bin/env node
/**
 * SourceMap 上传 CLI（零依赖，Node 18+ fetch）
 *
 * 用法（构建后调用）：
 *   node bin/sourcemap-cli.mjs \
 *     --server http://localhost:3000 \
 *     --apikey demo-key \
 *     --release v1.2.3 \
 *     --url https://cdn.example.com/app.js \
 *     --map dist/assets/app.js.map
 *
 * 多文件：--url/--map 可逗号分隔（一一对应）。
 * 退出码：全部成功 0；任一失败 1（CI 构建后步骤可直接用作门禁）。
 */
const args = process.argv.slice(2)

function argOf(name) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const server = argOf('server')
const apikey = argOf('apikey')
const release = argOf('release')
const urls = (argOf('url') ?? '').split(',').filter(Boolean)
const maps = (argOf('map') ?? '').split(',').filter(Boolean)

function fatal(message) {
  console.error(`[sourcemap-cli] ${message}`)
  process.exit(1)
}

if (!server || !apikey || !release) {
  fatal('缺少 --server / --apikey / --release 参数')
}
if (urls.length === 0 || urls.length !== maps.length) {
  fatal('--url 与 --map 需一一对应（逗号分隔多个）')
}

for (let i = 0; i < urls.length; i++) {
  const mapPath = maps[i]
  const bundleUrl = urls[i]
  let mapContent
  try {
    mapContent = (await import('node:fs')).readFileSync(mapPath, 'utf-8')
  } catch (error) {
    fatal(`读取 map 失败 ${mapPath}: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(mapContent)
  } catch {
    fatal(`map 不是合法 JSON: ${mapPath}`)
  }
  if (!parsed.version || !parsed.mappings) {
    fatal(`缺少 version/mappings 字段（确认是 source map 而非别的 JSON）: ${mapPath}`)
  }

  const res = await fetch(`${server}/api/sourcemaps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apikey },
    body: JSON.stringify({ release, url: bundleUrl, map: mapContent }),
  })
  if (!res.ok) {
    if (res.status === 413) {
      fatal(`上传失败 ${bundleUrl}: HTTP 413 —— map 超过服务端 body 上限（当前全局 256KB，真实项目 map 常为 MB 级；服务端需为 /api/sourcemaps 单独放开上限，见总纲 §3.7）`)
    }
    fatal(`上传失败 ${bundleUrl}: HTTP ${res.status} ${await res.text()}`)
  }
  console.log(`[sourcemap-cli] uploaded ${bundleUrl} (release=${release})`)
}
console.log('[sourcemap-cli] all done')
