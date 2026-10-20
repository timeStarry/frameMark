// Generates the e2e test images with ImageMagick (`magick`). Run only when the
// fixtures change: `node e2e/gen-fixtures.mjs`. Output is committed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const out = fileURLToPath(new URL('./fixtures/img/', import.meta.url))
mkdirSync(out, { recursive: true })

// name, width, height, gradient
const shapes = [
  ['land', 600, 400, 'gradient:#6a8caf-#2b3a4a'],
  ['port', 400, 600, 'gradient:#b08a5a-#3a2b1a'],
  ['pano', 1200, 200, 'gradient:#5aa07a-#1a3a2a'],
]

for (const [name, w, h, fill] of shapes) {
  for (const ext of ['avif', 'webp', 'jpg']) {
    const file = `${out}${name}.${ext}`
    execFileSync('magick', ['-size', `${w}x${h}`, fill, '-strip', '-quality', '60', file])
    const kb = statSync(file).size / 1024
    if (kb > 30) throw new Error(`${file} is ${kb.toFixed(1)} KB (limit 30)`)
  }
}
console.log('fixtures written to', out)
