import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCollection,
  deleteCollection,
  exposureCheck,
  getOwnerCollection,
  publish,
  publishDryRun,
  putCollection,
  putFrames,
  putOverride,
  putPhotoMeta,
  unpublish,
} from './desk'
import { session } from './session'
import type { CollectionFields, FrameInput } from './types'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function mockFetch(impl: (input: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

const call = (fn: ReturnType<typeof mockFetch>, i = 0) => {
  const [url, init] = fn.mock.calls[i]!
  return { url, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(init.body as string) }
}

const ID = 'a/b c?'
const ENC = 'a%2Fb%20c%3F'

const fields: CollectionFields = {
  title: 'T',
  intro: 'I',
  visibility: 'public',
  distribute: true,
  originalDownload: false,
  license: null,
  aiDeclaration: 'none',
  coverPhotoId: null,
}

const frames: FrameInput[] = [
  { layout: 'full', matteRatio: null, text: null, photoIds: ['p1'] },
  { layout: 'text', matteRatio: null, text: 'hi', photoIds: [] },
]

const view = { id: 'c1', title: 'T', updatedAt: 42, frames: [] }
const STALE = '这个合集在别处被修改过。'

beforeEach(() => {
  ;(session as { csrfToken: string | null }).csrfToken = 'tok'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getOwnerCollection', () => {
  it('GETs the encoded collection URL', async () => {
    const fn = mockFetch(async () => json({ id: 'c1', updatedAt: 1, frames: [] }))
    const r = await getOwnerCollection(ID)
    expect(fn.mock.calls[0]![0]).toBe(`/api/collections/${ENC}`)
    expect(r).toEqual({ ok: true, data: { id: 'c1', updatedAt: 1, frames: [] } })
  })
})

describe('createCollection', () => {
  it('POSTs only the title and returns the 201 view', async () => {
    const fn = mockFetch(async () => json(view, 201))
    const r = await createCollection('新合集')
    expect(call(fn)).toEqual({ url: '/api/collections', method: 'POST', body: { title: '新合集' } })
    expect(r).toEqual({ ok: true, status: 201, data: view })
  })
})

describe('putCollection', () => {
  it('sends the fields plus ifUpdatedAt', async () => {
    const fn = mockFetch(async () => json(view))
    const r = await putCollection(ID, fields, 41)
    expect(call(fn)).toEqual({ url: `/api/collections/${ENC}`, method: 'PUT', body: { ...fields, ifUpdatedAt: 41 } })
    expect(r.ok && r.data.updatedAt).toBe(42)
  })

  it('omits ifUpdatedAt when null', async () => {
    const fn = mockFetch(async () => json(view))
    await putCollection('c1', fields, null)
    const body = call(fn).body
    expect(body).toEqual(fields)
    expect('ifUpdatedAt' in body).toBe(false)
  })

  it('drops unknown keys from the fields object', async () => {
    const fn = mockFetch(async () => json(view))
    await putCollection('c1', { ...fields, extra: 1 } as CollectionFields, null)
    expect(call(fn).body).toEqual(fields)
  })

  it('maps a 409 to conflictAt', async () => {
    mockFetch(async () => json({ error: STALE, updatedAt: 99 }, 409))
    const r = await putCollection('c1', fields, 41)
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ status: 409, message: STALE, conflictAt: 99 })
  })

  it('leaves conflictAt unset on other failures', async () => {
    mockFetch(async () => json({ error: '标题需为 1–120 个字符。' }, 400))
    const r = await putCollection('c1', fields, 41)
    expect(r).toEqual({ ok: false, status: 400, message: '标题需为 1–120 个字符。' })
    expect('conflictAt' in r).toBe(false)
  })

  it('leaves conflictAt unset when a 409 carries no numeric updatedAt', async () => {
    mockFetch(async () => json({ error: STALE }, 409))
    const r = await putCollection('c1', fields, 41)
    expect('conflictAt' in r).toBe(false)
  })
})

describe('putFrames', () => {
  it('wraps frames with ifUpdatedAt', async () => {
    const fn = mockFetch(async () => json(view))
    const r = await putFrames(ID, frames, 7)
    expect(call(fn)).toEqual({ url: `/api/collections/${ENC}/frames`, method: 'PUT', body: { frames, ifUpdatedAt: 7 } })
    expect(r.ok && r.data.updatedAt).toBe(42)
  })

  it('omits ifUpdatedAt when null and strips extra frame keys', async () => {
    const fn = mockFetch(async () => json(view))
    await putFrames('c1', frames.map((f) => ({ ...f, key: 'k' }) as FrameInput), null)
    expect(call(fn).body).toEqual({ frames })
  })

  it('maps a 409 to conflictAt', async () => {
    mockFetch(async () => json({ error: STALE, updatedAt: 123 }, 409))
    expect(await putFrames('c1', frames, 7)).toMatchObject({ ok: false, status: 409, conflictAt: 123 })
  })
})

describe('putOverride', () => {
  it('encodes both ids and sends the override', async () => {
    const resp = { collectionId: 'c1', photoId: 'p/1', publicFields: ['camera'], histogramPublic: null, updatedAt: 5 }
    const fn = mockFetch(async () => json(resp))
    const r = await putOverride(ID, 'p/1', { publicFields: ['camera'], histogramPublic: null })
    expect(call(fn)).toEqual({
      url: `/api/collections/${ENC}/overrides/p%2F1`,
      method: 'PUT',
      body: { publicFields: ['camera'], histogramPublic: null },
    })
    expect(r).toEqual({ ok: true, status: 200, data: resp })
  })
})

describe('putPhotoMeta', () => {
  it('sends title and caption and returns bumped collections', async () => {
    const resp = { id: 'p1', title: 'a', caption: 'b', collections: [{ id: 'c1', updatedAt: 9 }] }
    const fn = mockFetch(async () => json(resp))
    const r = await putPhotoMeta('p 1', { title: 'a', caption: 'b' })
    expect(call(fn)).toEqual({ url: '/api/photos/p%201', method: 'PUT', body: { title: 'a', caption: 'b' } })
    expect(r.ok && r.data.collections).toEqual([{ id: 'c1', updatedAt: 9 }])
  })
})

describe('exposureCheck (mocked; server endpoint lands in Task 2)', () => {
  it('POSTs the proposed change and returns widens/changes', async () => {
    const resp = { widens: true, changes: [{ kind: 'photos', detail: '新增 1 张照片' }] }
    const fn = mockFetch(async () => json(resp))
    const body = { frames }
    const r = await exposureCheck(ID, body)
    expect(call(fn)).toEqual({ url: `/api/collections/${ENC}/exposure-check`, method: 'POST', body: { frames } })
    expect(r).toEqual({ ok: true, status: 200, data: resp })
  })

  it('passes collection and override parts through', async () => {
    const fn = mockFetch(async () => json({ widens: false, changes: [] }))
    const override = { photoId: 'p1', publicFields: ['iso'], histogramPublic: true }
    await exposureCheck('c1', { collection: fields, override })
    expect(call(fn).body).toEqual({ collection: fields, override })
  })
})

describe('publish', () => {
  it('dry run POSTs ?dry_run=1 and returns the manifest', async () => {
    const m = { photos: 3, publicFields: ['camera'], histogram: false, originalDownload: false, visibility: 'public', inSquare: true }
    const fn = mockFetch(async () => json(m))
    const r = await publishDryRun(ID)
    expect(call(fn)).toEqual({ url: `/api/collections/${ENC}/publish?dry_run=1`, method: 'POST', body: undefined })
    expect(r).toEqual({ ok: true, status: 200, data: m })
  })

  it('real publish POSTs without the query and returns the view', async () => {
    const fn = mockFetch(async () => json({ ...view, status: 'published' }))
    const r = await publish(ID)
    expect(call(fn)).toEqual({ url: `/api/collections/${ENC}/publish`, method: 'POST', body: undefined })
    expect(r.ok && r.data.updatedAt).toBe(42)
  })

  it('unpublish POSTs to /unpublish', async () => {
    const fn = mockFetch(async () => json({ ...view, status: 'draft' }))
    const r = await unpublish(ID)
    expect(call(fn)).toEqual({ url: `/api/collections/${ENC}/unpublish`, method: 'POST', body: undefined })
    expect(r.ok).toBe(true)
  })
})

describe('deleteCollection', () => {
  it('treats the 204 as success', async () => {
    const fn = mockFetch(async () => new Response(null, { status: 204 }))
    const r = await deleteCollection(ID)
    expect(call(fn)).toEqual({ url: `/api/collections/${ENC}`, method: 'DELETE', body: undefined })
    expect(r).toEqual({ ok: true, status: 204, data: undefined })
  })
})
