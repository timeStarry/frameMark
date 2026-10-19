// Intercepts /api/** and /m/** with fixture JSON and the generated images, and
// records every request URL for the privacy assertions.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page, Request, Route } from '@playwright/test'

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

/**
 * Location stuffed into a wall card on purpose (as MAIN's a1 does for the
 * viewer): the real wall endpoints never send it, and no wall page may render
 * it (privacy test). The values are distinctive so the DOM check can find them.
 */
export const CARD_LOCATION = { latitude: 31.2304, longitude: 121.4737 }

/** u1: salon; `main` is the second card. */
export const USER_U1 = {
  profile: { id: 'u1', name: '阿树', bio: '海边与礁石。', wallLayout: 'salon' },
  collections: [{ ...card(SOLO, 'land'), ...CARD_LOCATION }, card(MAIN, 'land'), ...Array.from({ length: 6 }, (_, i) => dummy(`t${i + 1}`, SHU, i))],
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

// ---- Account and archive (SP4a) ----
// mockAccount() layers a stateful, per-test author backend over mockAPI():
// routes registered later win, and anything it does not own falls back to the
// wall and viewer fixtures above.

/** The signed-in author. */
export const ME = { id: 'u9', name: '阿禾' }
export const EMAIL = 'me@example.com'
export const PASSWORD = 'correct horse battery staple'
export const VERIFY_TOKEN = 'tok-verify-7Qx2'
export const CSRF_MESSAGE = '会话校验失败，请刷新页面后重试。'
export const REGISTERED_MESSAGE = '如果该邮箱可以注册，验证邮件已发送。请在 30 分钟内打开链接并设置密码。'
/**
 * The app's origin and the S3 stand-in: another port on the same host, so it
 * is cross-origin (as a real presigned URL is) but same-site. Cookies ignore
 * ports, so the session cookie *would* ride along on a credentialed request;
 * only withCredentials=false keeps it off.
 */
export const APP_ORIGIN = 'http://127.0.0.1:4173'
export const S3_ORIGIN = 'http://127.0.0.1:4174'
export const SESSION_COOKIE = 'markr_session'

/** The author's own collections: a draft, an unlisted one and a public one. */
export const MINE_DRAFT = collection('d1', '未完成的海', ME, [full(photo('d1p', 'land'))])
export const MINE_UNLISTED = collection('d2', '给朋友看', ME, [full(photo('d2p', 'port'))])
export const MINE_PUBLIC = collection('d3', '礁石', ME, [full(photo('d3p', 'land'))])
for (const c of [MINE_DRAFT, MINE_UNLISTED, MINE_PUBLIC]) {
  COLLECTIONS[c.id] = c
  NEIGHBORS[c.id] = { wall: 'square', prev: null, next: null, strip: [] }
}
const MINE = [
  { c: MINE_DRAFT, status: 'draft', visibility: 'private' },
  { c: MINE_UNLISTED, status: 'published', visibility: 'unlisted' },
  { c: MINE_PUBLIC, status: 'published', visibility: 'public' },
] as const

export const fixtureFile = (shape: Shape) => readFileSync(`${imgDir}${shape}.jpg`)
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
/** land.jpg is already in the archive (the duplicate); port.jpg is new. */
export const DUP_SHA = sha256(fixtureFile('land'))

interface Archived {
  photo: Record<string, unknown> & { id: string; status: string }
  sha: string
  inCollection: boolean
  year: number
}

/** Years newest first: 12 × 2026, 10 × 2025, 8 × 2024. */
export const ARCHIVE_YEARS: number[] = [...Array(12).fill(2026), ...Array(10).fill(2025), ...Array(8).fill(2024)]
const CAMERAS = ['X100V', 'GR III']

function ownerPhoto(id: string, shape: Shape, year: number, i: number, over: Record<string, unknown> = {}) {
  const [width, height] = DIMS[shape]
  return {
    id,
    status: 'ready',
    error: null,
    title: `归档 ${id}`,
    caption: '',
    width,
    height,
    format: 'jpeg',
    createdAt: Date.UTC(year, 6, 1) - i * 60_000,
    publicFields: ['aperture', 'iso'],
    histogramPublic: false,
    originalDownload: false,
    exif: { camera: CAMERAS[i % 2], focalLength: 23, aperture: 2, shutter: '1/250', iso: 200, takenAt: Date.UTC(year, 4, 3, 10) - i * 3_600_000 },
    media: media(id, shape),
    ...over,
  }
}

function seedArchive(n: number): Archived[] {
  return ARCHIVE_YEARS.slice(0, n).map((year, i) => ({
    photo: ownerPhoto(`p${i + 1}`, SHAPES[i % SHAPES.length]!, year, i),
    sha: i === 0 ? DUP_SHA : `seed-${i}`,
    inCollection: i % 2 === 0,
    year,
  }))
}

export interface WriteLog {
  method: string
  path: string
  body: unknown
  csrf: string | undefined
  status: number
}

export interface AccountState {
  user: string | null
  csrf: string
  registrationOpen: boolean
  archive: Archived[]
  prefs: Record<string, unknown>
  profile: { name: string; bio: string; wallLayout: 'salon' | 'grid' }
}

export interface AccountMock extends Mock {
  state: AccountState
  /** Every non-GET under /api, in order, with the status the mock answered. */
  writes: WriteLog[]
  /** Every non-OPTIONS request to the S3 stand-in, with all its headers. */
  s3: { method: string; url: string; headers: Record<string, string>; bytes: number }[]
  /** All headers of each /api write (positive control for the cookie check). */
  apiHeaders: Record<string, string>[]
  /** page.url() at the moment POST /api/auth/verify arrived. */
  verifyPageURL: string | null
  /** Request paths under /api in arrival order (method + path). */
  order: string[]
  /** Rotate the server's token behind the page's back: its next write is stale. */
  staleToken(): void
}

export interface AccountOptions {
  signedIn?: boolean
  registrationOpen?: boolean
  photos?: number
  pageSize?: number
}

export async function mockAccount(page: Page, opts: AccountOptions = {}): Promise<AccountMock> {
  const base = await mockAPI(page)
  const pageSize = opts.pageSize ?? 20
  let seq = 0
  let uploads = 0
  const rotate = () => `csrf-${++seq}`
  const polls = new Map<string, number>()
  const putDone = new Set<string>()

  const m: AccountMock = {
    requests: base.requests,
    state: {
      user: opts.signedIn ? ME.id : null,
      csrf: rotate(),
      registrationOpen: opts.registrationOpen ?? false,
      archive: seedArchive(opts.photos ?? 30),
      prefs: {
        publicFields: ['camera', 'lens', 'focal_length', 'aperture', 'shutter', 'iso'],
        histogramPublic: true,
        originalDownload: false,
        watermark: null,
        defaultLicense: null,
        defaultAiDeclaration: null,
        locationMode: 'off',
        updatedAt: null,
      },
      profile: { name: ME.name, bio: '只拍海。', wallLayout: 'salon' },
    },
    writes: [],
    s3: [],
    apiHeaders: [],
    verifyPageURL: null,
    order: [],
    staleToken: () => {
      m.state.csrf = rotate()
    },
  }
  const st = m.state

  // A real HttpOnly session cookie, as the backend sets it (identity.go).
  const setCookie = async (on: boolean) => {
    const ctx = page.context()
    if (!on) return ctx.clearCookies({ name: SESSION_COOKIE })
    await ctx.addCookies([{ name: SESSION_COOKIE, value: `s-${seq}`, url: APP_ORIGIN, httpOnly: true, sameSite: 'Lax' }])
  }
  if (st.user) await setCookie(true)

  const userWall = () => {
    const owner = st.user === ME.id
    const cards = MINE.filter((x) => owner || (x.status === 'published' && x.visibility === 'public')).map((x) => ({
      ...card(x.c, 'land'),
      ...(owner ? { status: x.status, visibility: x.visibility } : {}),
    }))
    return { profile: { id: ME.id, ...st.profile }, collections: cards, albums: [] }
  }

  const facets = () => {
    const count = <K>(keys: K[]) => {
      const out = new Map<K, number>()
      for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1)
      return [...out]
    }
    return {
      years: count(st.archive.map((a) => a.year)).map(([year, c]) => ({ year, count: c })),
      cameras: count(st.archive.map((a) => String((a.photo.exif as { camera: string }).camera))).map(([name, c]) => ({ name, count: c })),
      lenses: [],
    }
  }

  await page.route('**/mock-s3/**', async (route: Route) => {
    const req = route.request()
    const cors = {
      'Access-Control-Allow-Origin': APP_ORIGIN,
      'Access-Control-Allow-Methods': 'PUT',
      'Access-Control-Allow-Headers': 'content-type, x-amz-checksum-sha256',
    }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    m.s3.push({ method: req.method(), url: req.url(), headers: await req.allHeaders(), bytes: req.postDataBuffer()?.length ?? 0 })
    putDone.add(new URL(req.url()).pathname.split('/').pop()!)
    return route.fulfill({ status: 200, headers: cors, body: '' })
  })

  await page.route('**/api/**', async (route: Route) => {
    const req: Request = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    const method = req.method()
    m.order.push(`${method} ${path}`)
    const reply = (status: number, body?: unknown) => {
      if (method !== 'GET') {
        let parsed: unknown = undefined
        try {
          parsed = req.postData() ? JSON.parse(req.postData()!) : undefined
        } catch {
          parsed = req.postData()
        }
        m.writes.push({ method, path, body: parsed, csrf: req.headers()['x-csrf-token'], status })
      }
      if (body === undefined) return route.fulfill({ status, body: '' })
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    }
    const fail = (status: number, error: string) => reply(status, { error })
    const input = () => {
      try {
        return (JSON.parse(req.postData() ?? 'null') ?? {}) as Record<string, unknown>
      } catch {
        return {}
      }
    }

    if (method !== 'GET') {
      m.apiHeaders.push(await req.allHeaders())
      const tok = req.headers()['x-csrf-token']
      if (tok !== st.csrf) {
        return fail(403, CSRF_MESSAGE)
      }
    }

    if (path === '/api/auth/session' && method === 'GET') {
      return reply(200, { user: st.user, csrfToken: st.csrf, registrationOpen: st.registrationOpen })
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const b = input()
      if (b.email !== EMAIL || b.password !== PASSWORD) return fail(401, '邮箱或密码不正确。')
      st.user = ME.id
      st.csrf = rotate()
      await setCookie(true)
      return reply(200, { user: st.user, csrfToken: st.csrf })
    }
    if (path === '/api/auth/register' && method === 'POST') {
      if (!st.registrationOpen) return fail(403, '注册尚未开放。')
      return reply(202, { message: REGISTERED_MESSAGE })
    }
    if (path === '/api/auth/verify' && method === 'POST') {
      m.verifyPageURL = page.url()
      const b = input()
      if (b.token !== VERIFY_TOKEN) return fail(400, '链接无效或已过期。')
      if (typeof b.password !== 'string' || [...b.password].length < 15) return fail(400, '密码至少需要 15 个字符。')
      st.user = ME.id
      st.csrf = rotate()
      await setCookie(true)
      return reply(201, { user: st.user, csrfToken: st.csrf })
    }
    if ((path === '/api/auth/logout' || path === '/api/auth/logout-all') && method === 'POST') {
      st.user = null
      st.csrf = rotate()
      await setCookie(false)
      return reply(200, { user: null })
    }
    if (path === `/api/u/${ME.id}` && method === 'GET') return reply(200, userWall())
    // The draft is private: the backend answers 404 to anyone but its owner.
    const draft = path.match(/^\/api\/collections\/([^/]+)(\/neighbors)?$/)
    if (draft && draft[1] === MINE_DRAFT.id && method === 'GET' && st.user !== ME.id) return fail(404, '未找到。')

    // Everything below is the owner API.
    const owner = /^\/api\/(archive|uploads|photos|upload-prefs|profile)(\/|$)/.test(path)
    if (!owner) return route.fallback()
    if (path.includes('/original')) return route.fallback()
    if (st.user !== ME.id) return fail(401, '请先登录。')

    if (path === '/api/archive' && method === 'GET') {
      const q = url.searchParams
      let list = st.archive
      if (q.has('year')) list = list.filter((a) => String(a.year) === q.get('year'))
      if (q.has('in_collection')) list = list.filter((a) => a.inCollection === (q.get('in_collection') === 'true'))
      if (q.has('status')) list = list.filter((a) => a.photo.status === q.get('status'))
      if (q.has('camera')) list = list.filter((a) => (a.photo.exif as { camera?: string } | null)?.camera === q.get('camera'))
      const start = Number(q.get('cursor') ?? '0')
      const items = list.slice(start, start + pageSize).map((a) => a.photo)
      const next = start + pageSize < list.length ? String(start + pageSize) : null
      return reply(200, { items, nextCursor: next, facets: facets() })
    }
    if (path === '/api/uploads' && method === 'POST') {
      const b = input()
      const known = st.archive.find((a) => a.sha === b.sha256)
      if (known) return reply(200, known.photo)
      const id = `up${++uploads}`
      const ct = String(b.contentType)
      st.archive.unshift({
        photo: ownerPhoto(id, 'port', 2026, 0, { status: 'uploading', title: String(b.filename).replace(/\.[^.]+$/, ''), createdAt: Date.UTC(2026, 9, 18) }),
        sha: String(b.sha256),
        inCollection: false,
        year: 2026,
      })
      return reply(201, {
        photoId: id,
        upload: { url: `${S3_ORIGIN}/mock-s3/${id}`, method: 'PUT', headers: { 'Content-Type': ct, 'x-amz-checksum-sha256': `sum-${id}` } },
        expiresAt: Date.now() + 15 * 60_000,
      })
    }
    const done = path.match(/^\/api\/uploads\/([^/]+)\/complete$/)
    if (done && method === 'POST') {
      const a = st.archive.find((x) => x.photo.id === done[1])
      if (!a) return fail(404, '未找到。')
      if (!putDone.has(a.photo.id)) return fail(409, '原图尚未上传。')
      // Like completeUpload: 202 when it queues processing, 200 if already done.
      if (a.photo.status === 'processing' || a.photo.status === 'ready') return reply(200, a.photo)
      a.photo.status = 'processing'
      return reply(202, a.photo)
    }
    const ph = path.match(/^\/api\/photos\/([^/]+)$/)
    if (ph) {
      const i = st.archive.findIndex((x) => x.photo.id === ph[1])
      if (i < 0) return fail(404, '未找到。')
      const a = st.archive[i]!
      if (method === 'DELETE') {
        st.archive.splice(i, 1)
        // The real backend answers 204 with no body.
        return reply(204)
      }
      if (method === 'GET') {
        const n = (polls.get(a.photo.id) ?? 0) + 1
        polls.set(a.photo.id, n)
        // Ready on the second poll.
        if (a.photo.status === 'processing' && n >= 2) a.photo.status = 'ready'
        return reply(200, a.photo)
      }
    }
    if (path === '/api/upload-prefs') {
      if (method === 'GET') return reply(200, st.prefs)
      if (method === 'PUT') {
        st.prefs = { ...input(), updatedAt: Date.now() }
        return reply(200, st.prefs)
      }
    }
    if (path === '/api/profile' && method === 'PUT') {
      const b = input()
      st.profile = { name: String(b.name).trim(), bio: String(b.bio ?? '').trim(), wallLayout: b.wallLayout === 'grid' ? 'grid' : 'salon' }
      return reply(200, { userId: ME.id, ...st.profile, updatedAt: Date.now() })
    }
    return fail(404, '未找到。')
  })
  return m
}
