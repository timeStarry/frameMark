import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeUpload, createUpload, deletePhoto, getArchive, getPhoto, getPrefs, putPrefs, putProfile } from './me'
import { session } from './session'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function mockFetch(impl: (input: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  ;(session as { csrfToken: string | null }).csrfToken = 'tok'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getArchive', () => {
  it('omits empty filters', async () => {
    const fn = mockFetch(async () => json({ items: [], nextCursor: null, facets: {} }))
    await getArchive({}, null)
    expect(fn.mock.calls[0]![0]).toBe('/api/archive')
  })

  it('maps and encodes every filter', async () => {
    const fn = mockFetch(async () => json({}))
    await getArchive(
      { year: 2024, camera: 'Canon EOS R5', lens: 'RF 24-70mm F2.8 L & co', focalMin: 24, focalMax: 70.5, inCollection: false, status: 'ready' },
      'abc/=+',
    )
    const url = new URL(fn.mock.calls[0]![0], 'http://x')
    expect(url.pathname).toBe('/api/archive')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      year: '2024',
      camera: 'Canon EOS R5',
      lens: 'RF 24-70mm F2.8 L & co',
      focal_min: '24',
      focal_max: '70.5',
      in_collection: 'false',
      status: 'ready',
      cursor: 'abc/=+',
    })
    expect(fn.mock.calls[0]![0]).not.toContain('&co')
    expect(fn.mock.calls[0]![0]).not.toContain('/=+')
  })

  it('sends in_collection=true and leaves out undefined fields', async () => {
    const fn = mockFetch(async () => json({}))
    await getArchive({ inCollection: true, camera: undefined, year: undefined }, null)
    expect(fn.mock.calls[0]![0]).toBe('/api/archive?in_collection=true')
  })

  it('passes the abort signal and returns ok:false on errors', async () => {
    const fn = mockFetch(async () => json({ error: '请先登录。' }, 401))
    const ctl = new AbortController()
    expect(await getArchive({}, null, ctl.signal)).toEqual({ ok: false, status: 401 })
    expect(fn.mock.calls[0]![1]?.signal).toBe(ctl.signal)
  })
})

describe('photos', () => {
  it('getPhoto encodes the id', async () => {
    const fn = mockFetch(async () => json({ id: 'a/b' }))
    await getPhoto('a/b')
    expect(fn.mock.calls[0]![0]).toBe('/api/photos/a%2Fb')
  })

  it('deletePhoto sends DELETE with the token and reads a 204 as success', async () => {
    const fn = mockFetch(async () => new Response(null, { status: 204 }))
    expect(await deletePhoto('p1')).toEqual({ ok: true, status: 204, data: undefined })
    const [url, init] = fn.mock.calls[0]!
    expect(url).toBe('/api/photos/p1')
    expect(init?.method).toBe('DELETE')
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('tok')
  })

  it('completeUpload posts to the complete endpoint', async () => {
    const fn = mockFetch(async () => json({ id: 'p1', status: 'processing' }))
    const r = await completeUpload('p1')
    expect(r).toMatchObject({ ok: true, data: { status: 'processing' } })
    expect(fn.mock.calls[0]![0]).toBe('/api/uploads/p1/complete')
    expect(fn.mock.calls[0]![1]?.method).toBe('POST')
  })
})

describe('createUpload', () => {
  const file = { filename: 'a.jpg', bytes: 10, sha256: 'ab'.repeat(32), contentType: 'image/jpeg' }

  it('sends exactly the four fields', async () => {
    const fn = mockFetch(async () => json({ photoId: 'p1' }, 201))
    await createUpload({ ...file, extra: 1 } as typeof file)
    expect(JSON.parse(fn.mock.calls[0]![1]!.body as string)).toEqual(file)
    expect(fn.mock.calls[0]![0]).toBe('/api/uploads')
  })

  it('returns 201 with an UploadInit', async () => {
    const init = { photoId: 'p1', upload: { url: 'https://s3/x', method: 'PUT', headers: {} }, expiresAt: 1 }
    mockFetch(async () => json(init, 201))
    expect(await createUpload(file)).toEqual({ ok: true, status: 201, data: init })
  })

  it('returns 200 with the existing OwnerPhoto for a duplicate', async () => {
    const photo = { id: 'p0', status: 'ready' }
    mockFetch(async () => json(photo, 200))
    expect(await createUpload(file)).toEqual({ ok: true, status: 200, data: photo })
  })
})

describe('prefs and profile', () => {
  it('getPrefs reads /api/upload-prefs', async () => {
    const fn = mockFetch(async () => json({ publicFields: [] }))
    expect((await getPrefs()).ok).toBe(true)
    expect(fn.mock.calls[0]![0]).toBe('/api/upload-prefs')
  })

  it('putPrefs PUTs the prefs body', async () => {
    const p = {
      publicFields: ['camera'],
      histogramPublic: true,
      originalDownload: false,
      watermark: null,
      defaultLicense: null,
      defaultAiDeclaration: null,
      locationMode: 'off' as const,
    }
    const fn = mockFetch(async () => json({ ...p, updatedAt: 5 }))
    await putPrefs(p)
    const [url, init] = fn.mock.calls[0]!
    expect(url).toBe('/api/upload-prefs')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init!.body as string)).toEqual(p)
  })

  it('putProfile PUTs name, bio and wallLayout only', async () => {
    const fn = mockFetch(async () => json({}))
    const p = { name: 'N', bio: 'B', wallLayout: 'grid' as const }
    await putProfile({ ...p, extra: 1 } as typeof p)
    const [url, init] = fn.mock.calls[0]!
    expect(url).toBe('/api/profile')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init!.body as string)).toEqual(p)
  })
})
