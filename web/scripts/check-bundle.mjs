// Fails when the critical path of /c/:id or / (entry + route chunk and their
// static imports, JS and CSS) exceeds 80 KB gzipped. Each route is measured separately.
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const LIMIT = 80 * 1024
const dist = fileURLToPath(new URL('../../internal/webui/dist', import.meta.url))
const manifestPath = resolve(dist, '.vite/manifest.json')

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (err) {
  console.error(`无法读取 ${manifestPath}：先运行 npm run build。`, err.message)
  process.exit(1)
}

const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry)
if (!entryKey) {
  console.error('manifest 中缺少入口')
  process.exit(1)
}

/** Gzipped size of the entry plus one route chunk and their static imports. */
function measure(routeKey) {
  if (!manifest[routeKey]) {
    console.error(`manifest 中缺少 ${routeKey}`)
    process.exit(1)
  }
  const files = new Set()
  const seen = new Set()
  function walk(key) {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (!chunk) return
    files.add(chunk.file)
    for (const css of chunk.css ?? []) files.add(css)
    for (const dep of chunk.imports ?? []) walk(dep)
  }
  walk(entryKey)
  walk(routeKey)
  let total = 0
  for (const file of files) {
    const size = gzipSync(readFileSync(resolve(dist, file))).length
    total += size
    console.log(`${(size / 1024).toFixed(2).padStart(8)} KB  ${file}`)
  }
  return total
}

let failed = false
for (const [path, routeKey] of [
  ['/c/:id', 'src/routes/CollectionRoute.vue'],
  ['/', 'src/routes/SquareRoute.vue'],
]) {
  console.log(`${path} (${routeKey})`)
  const total = measure(routeKey)
  console.log(`${(total / 1024).toFixed(2).padStart(8)} KB  ${path} total (limit ${LIMIT / 1024} KB)`)
  if (total > LIMIT) {
    console.error(`超出 ${path} 首屏体积预算。`)
    failed = true
  }
}
if (failed) process.exit(1)
