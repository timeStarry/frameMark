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
  previews: [media(`${c.id}-p1`, shape), media(`${c.id}-p2`, 'port'), media(`${c.id}-p3`, 'land')],
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
/** Ten frames: on a short landscape phone the ticks do not fit at 44px each. */
export const MANY = collection('many', '十帧', SHU, Array.from({ length: 10 }, (_, i) => full(photo(`m${i + 1}`, 'land'))))
NEIGHBORS.many = { wall: 'square', prev: null, next: null, strip: [] }
const COLLECTIONS: Record<string, unknown> = { main: MAIN, next: NEXT, solo: SOLO, broken: BROKEN, long: LONG, many: MANY }

// ---- Walls (SP3) ----
const SHAPES: Shape[] = ['land', 'port', 'pano', 'port', 'land']
/** A wall-only card: never clicked, so it needs no collection fixture. */
const dummy = (id: string, owner: { id: string; name: string }, i: number, count = 3 + (i % 9)) =>
  ({ ...card(collection(id, `墙 ${id}`, owner, []), SHAPES[i % SHAPES.length]!), count })

/** Card whose cover images 404 (cover id `missing`). */
export const BROKEN_CARD = { ...card(BROKEN, 'land'), cover: media('missing', 'land') }

/**
 * Square page 1: 2 featured + 24 items (`broken` at index 3), nextCursor p2.
 * Page 2: 10 items; its 4th is `main`, the 30th card on the wall.
 */
export const SQUARE_P1 = {
  featured: [dummy('f1', LIN, 0), dummy('f2', SHU, 1)],
  items: Array.from({ length: 24 }, (_, i) => (i === 3 ? BROKEN_CARD : dummy(`q${i + 1}`, i % 2 ? SHU : LIN, i + 2))),
  nextCursor: 'p2' as string | null,
}
export const SQUARE_P2 = {
  featured: [],
  items: Array.from({ length: 10 }, (_, i) => (i === 3 ? card(MAIN, 'land') : dummy(`r${i + 1}`, i % 2 ? SHU : LIN, i + 7))),
  nextCursor: null,
}
/** Wall order on `/` once both pages are in. */
export const SQUARE_ORDER = [...SQUARE_P1.featured, ...SQUARE_P1.items, ...SQUARE_P2.items].map((c) => c.id)

/** u1: salon; `main` is the second card. */
export const USER_U1 = {
  profile: { id: 'u1', name: '阿树', bio: '海边与礁石。', wallLayout: 'salon' },
  collections: [card(SOLO, 'land'), card(MAIN, 'land'), ...Array.from({ length: 6 }, (_, i) => dummy(`t${i + 1}`, SHU, i))],
  albums: [{ id: 'al1', title: '海岸', intro: '', count: 3, cover: media('al1-cover', 'land') }],
}
/** u2: grid. */
export const USER_U2 = {
  profile: { id: 'u2', name: '林', bio: '', wallLayout: 'grid' },
  collections: [card(NEXT, 'port'), ...Array.from({ length: 9 }, (_, i) => dummy(`g${i + 1}`, LIN, i))],
  albums: [],
}
export const ALBUM_AL1 = {
  id: 'al1',
  title: '海岸',
  intro: '三组海边的照片。',
  owner: SHU,
  members: [card(MAIN, 'land'), card(NEXT, 'port'), card(SOLO, 'land'), ...Array.from({ length: 4 }, (_, i) => dummy(`m-al${i + 1}`, SHU, i))],
}

/** The wall the neighbors API reports: `user` / `user:*` become the owner's wall. */
function echoWall(requested: string | null, id: string): string {
  if (requested === null) return 'square'
  if (requested === 'user' || requested.startsWith('user:')) {
    const owner = (COLLECTIONS[id] as { owner?: { id: string } } | undefined)?.owner?.id
    return owner ? `user:${owner}` : requested
  }
  return requested
}

export interface Mock {
  requests: string[]
}

export async function mockAPI(page: Page, opts: { mediaDelayMs?: number; squareDelayMs?: number } = {}): Promise<Mock> {
  const mock: Mock = { requests: [] }
  page.on('request', (r) => mock.requests.push(r.url()))

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url())
    const m = url.pathname.match(/^\/api\/collections\/([^/]+)(\/neighbors)?$/)
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (m) {
      const nb = NEIGHBORS[m[1]!] as Record<string, unknown> | undefined
      const body = m[2] ? nb && { ...nb, wall: echoWall(url.searchParams.get('wall'), m[1]!) } : COLLECTIONS[m[1]!]
      if (body) return json(body)
    }
    if (url.pathname === '/api/square') {
      const cursor = url.searchParams.get('cursor')
      if (!cursor) return json(SQUARE_P1)
      if (cursor === 'p2') {
        if (opts.squareDelayMs) await new Promise((r) => setTimeout(r, opts.squareDelayMs))
        return json(SQUARE_P2)
      }
    }
    if (url.pathname === '/api/u/u1') return json(USER_U1)
    if (url.pathname === '/api/u/u2') return json(USER_U2)
    if (url.pathname === '/api/albums/al1') return json(ALBUM_AL1)
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
