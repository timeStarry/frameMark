// Intercepts /api/** and /m/** with fixture JSON and the generated images, and
// records every request URL for the privacy assertions.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page, Route } from '@playwright/test'

type Shape = 'land' | 'port' | 'pano'
const DIMS: Record<Shape, [number, number]> = { land: [6000, 4000], port: [4000, 6000], pano: [12000, 2000] }
const TIERS = ['w480', 'w1280', 'w2400', 'w3840'] as const

const imgDir = fileURLToPath(new URL('./fixtures/img/', import.meta.url))
const MIME: Record<string, string> = { avif: 'image/avif', webp: 'image/webp', jpg: 'image/jpeg' }

function media(id: string, shape: Shape) {
  const [width, height] = DIMS[shape]
  const tiers = Object.fromEntries(
    TIERS.map((t) => [t, { avif: `/m/${shape}/${id}/${t}.avif`, webp: `/m/${shape}/${id}/${t}.webp`, jpeg: `/m/${shape}/${id}/${t}.jpg` }]),
  )
  return { width, height, tiers }
}

export const EXIF = {
  camera: 'X100V',
  lens: 'Fujinon 23mm',
  focalLength: 23,
  focalLength35mm: 35,
  aperture: 2,
  shutter: '1/250',
  iso: 200,
  takenAt: Date.UTC(2026, 4, 3, 10),
}

function hist() {
  const ch = (k: number) => Array.from({ length: 64 }, (_, i) => Math.round(50 + 40 * Math.sin((i * k) / 10)))
  return [ch(1), ch(2), ch(3), ch(4)]
}

function photo(id: string, shape: Shape, over: Record<string, unknown> = {}) {
  const [width, height] = DIMS[shape]
  return {
    id,
    title: `照片 ${id}`,
    caption: `图注 ${id}`,
    width,
    height,
    media: media(id, shape),
    exif: null,
    histogram: null,
    attribution: null,
    downloadable: false,
    ...over,
  }
}

const full = (p: unknown) => ({ layout: 'full', matteRatio: null, text: null, photos: [p] })

function collection(id: string, title: string, owner: { id: string; name: string }, frames: unknown[]) {
  return {
    id,
    title,
    intro: '',
    owner,
    license: 'CC BY-NC 4.0',
    aiDeclaration: '未使用生成式 AI。',
    originalDownload: true,
    cover: null,
    publishedAt: Date.UTC(2026, 5, 1),
    frames,
  }
}

const SHU = { id: 'u1', name: '阿树' }
const LIN = { id: 'u2', name: '林' }

/** Main collection: landscape (full EXIF + histogram), portrait, panorama, pair, text, bare photo. */
export const MAIN = collection('main', '海边', SHU, [
  // Location stuffed in on purpose: the viewer must never render it (privacy test).
  full(photo('a1', 'land', { exif: { ...EXIF, latitude: 31.2304, longitude: 121.4737 }, histogram: hist(), downloadable: true })),
  full(photo('a2', 'port', { exif: { iso: 400 } })),
  full(photo('a3', 'pano')),
  { layout: 'pair', matteRatio: null, text: null, photos: [photo('a4', 'port', { exif: EXIF }), photo('a5', 'port')] },
  { layout: 'text', matteRatio: null, text: '潮水退去以后，礁石上留下一层很薄的光。', photos: [] },
  full(photo('a6', 'land')),
])
export const NEXT = collection('next', '山中', LIN, [full(photo('b1', 'port')), full(photo('b2', 'land'))])
export const SOLO = collection('solo', '独张', SHU, [full(photo('s1', 'land'))])
/** A photo whose images 404. */
export const BROKEN = collection('broken', '坏图', SHU, [
  full({ ...photo('x1', 'land'), media: media('missing', 'land') }),
  full(photo('x2', 'land')),
])

const card = (c: ReturnType<typeof collection>, shape: Shape) => ({
  id: c.id,
  title: c.title,
  owner: c.owner,
  count: c.frames.length,
  cover: media(`${c.id}-cover`, shape),
})

const NEIGHBORS: Record<string, unknown> = {
  main: { wall: 'square', prev: null, next: card(NEXT, 'port'), strip: [card(MAIN, 'land'), card(NEXT, 'port')] },
  next: { wall: 'square', prev: card(MAIN, 'land'), next: null, strip: [card(MAIN, 'land'), card(NEXT, 'port')] },
  solo: { wall: 'square', prev: null, next: null, strip: [card(SOLO, 'land')] },
  broken: { wall: 'square', prev: null, next: null, strip: [] },
}
/** A collection whose strip is far wider than a phone. */
export const LONG = collection('long', '长带', SHU, [full(photo('l1', 'land'))])
const LONG_STRIP = [card(LONG, 'land'), ...Array.from({ length: 9 }, (_, i) => card(collection(`s${i}`, `带${i}`, SHU, []), 'land'))]
NEIGHBORS.long = { wall: 'square', prev: null, next: null, strip: LONG_STRIP }
const COLLECTIONS: Record<string, unknown> = { main: MAIN, next: NEXT, solo: SOLO, broken: BROKEN, long: LONG }

export interface Mock {
  requests: string[]
}

export async function mockAPI(page: Page, opts: { mediaDelayMs?: number } = {}): Promise<Mock> {
  const mock: Mock = { requests: [] }
  page.on('request', (r) => mock.requests.push(r.url()))

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url())
    const m = url.pathname.match(/^\/api\/collections\/([^/]+)(\/neighbors)?$/)
    if (m) {
      const body = m[2] ? NEIGHBORS[m[1]!] : COLLECTIONS[m[1]!]
      if (body) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    }
    if (url.pathname.includes('/original')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: readFileSync(`${imgDir}land.jpg`) })
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"未找到。"}' })
  })

  await page.route('**/m/**', async (route: Route) => {
    const url = new URL(route.request().url())
    const [, , shape, id, file] = url.pathname.split('/')
    if (opts.mediaDelayMs) await new Promise((r) => setTimeout(r, opts.mediaDelayMs))
    const ext = file?.split('.').pop() ?? ''
    if (id === 'missing' || !(shape! in DIMS) || !MIME[ext]) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ status: 200, contentType: MIME[ext], body: readFileSync(`${imgDir}${shape}.${ext}`) })
  })
  return mock
}
