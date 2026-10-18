import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import type { ArchivePage, ArchiveQuery, OwnerPhoto } from '../api/types'
import type { Result } from '../api/client'
import type { WriteResult } from '../api/write'
import { media } from '../viewer/testFixtures'
import { FakeIO } from '../routes/wallTestUtils'

const api = vi.hoisted(() => ({
  getArchive: vi.fn(),
  getPhoto: vi.fn(),
  deletePhoto: vi.fn(),
  createUpload: vi.fn(),
  completeUpload: vi.fn(),
}))
vi.mock('../api/me', () => api)
vi.mock('./sha256', () => ({ sha256Hex: async (f: File) => `h-${f.name}` }))

import ArchiveRoute from './ArchiveRoute.vue'

type Call = { q: ArchiveQuery; cursor: string | null; signal: AbortSignal | undefined }
let calls: Call[] = []
let observers: FakeIO[] = []

function owner(id: string, over: Partial<OwnerPhoto> = {}): OwnerPhoto {
  return {
    id,
    status: 'ready',
    error: null,
    title: `标题${id}`,
    caption: '',
    width: 6000,
    height: 4000,
    format: 'jpeg',
    createdAt: Date.UTC(2026, 0, 1),
    publicFields: ['aperture', 'iso'],
    histogramPublic: false,
    originalDownload: false,
    exif: { camera: 'X100V', aperture: 2, iso: 200, takenAt: Date.UTC(2026, 4, 3, 10) },
    media: media(id),
    ...over,
  }
}

const FACETS: ArchivePage['facets'] = {
  years: [
    { year: 2026, count: 3 },
    { year: 2025, count: 1 },
  ],
  cameras: [{ name: 'X100V', count: 4 }],
  lenses: [{ name: 'Fujinon 23mm', count: 4 }],
}

function page(items: OwnerPhoto[], nextCursor: string | null = null): ArchivePage {
  return { items, nextCursor, facets: FACETS }
}

/** Replies keyed by `${JSON of q}|${cursor}`; a missing key resolves `fallback`. */
let replies: Record<string, Result<ArchivePage> | Promise<Result<ArchivePage>>> = {}
let fallback: Result<ArchivePage> = { ok: true, data: page([]) }
const key = (q: ArchiveQuery, cursor: string | null) => `${JSON.stringify(q)}|${cursor ?? ''}`

let router: Router
let w: VueWrapper | null = null

async function open(url = '/me') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/me', name: 'archive', component: ArchiveRoute },
      { path: '/elsewhere', component: { render: () => null } },
    ],
  })
  await router.push(url)
  await router.isReady()
  w = mount(defineComponent({ render: () => h(RouterView) }), { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return w
}

const tiles = () => w!.findAll('button[data-photo-id]')
const tileIds = () => tiles().map((t) => t.attributes('data-photo-id'))
const tile = (id: string) => w!.find(`button[data-photo-id="${id}"]`)
const button = (text: string) => w!.findAll('button').find((b) => b.text() === text)
const focusedId = () => (document.activeElement as HTMLElement | null)?.dataset.photoId ?? null

beforeEach(() => {
  calls = []
  observers = []
  replies = {}
  fallback = { ok: true, data: page([]) }
  api.getArchive.mockReset().mockImplementation((q: ArchiveQuery, cursor: string | null, signal?: AbortSignal) => {
    calls.push({ q, cursor, signal })
    return Promise.resolve(replies[key(q, cursor)] ?? fallback)
  })
  api.getPhoto.mockReset()
  api.deletePhoto.mockReset()
  api.createUpload.mockReset()
  api.completeUpload.mockReset()
  vi.stubGlobal(
    'IntersectionObserver',
    class extends FakeIO {
      constructor(cb: IntersectionObserverCallback, o?: IntersectionObserverInit) {
        super(cb, o)
        observers.push(this)
      }
    },
  )
})

afterEach(() => {
  w?.unmount()
  w = null
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('ArchiveRoute grid', () => {
  it('renders square tiles labelled with title and date, and a labelled main', async () => {
    fallback = {
      ok: true,
      data: page([
        owner('p1'),
        owner('p2', { title: '海', exif: { takenAt: Date.UTC(2026, 4, 3, 20), takenOffsetMinutes: 480 } }),
        owner('p3', { exif: null }),
      ]),
    }
    await open()
    expect(tileIds()).toEqual(['p1', 'p2', 'p3'])
    expect(tile('p1').attributes('aria-label')).toBe('标题p1，2026.05.03')
    // takenOffsetMinutes applies: 20:00 UTC + 8h is the next day locally.
    expect(tile('p2').attributes('aria-label')).toBe('海，2026.05.04')
    expect(tile('p3').attributes('aria-label')).toBe('标题p3，未知日期')
    expect(tile('p1').attributes('type')).toBe('button')
    const main = w!.find('main')
    expect(main.attributes('aria-labelledby')).toBe(w!.find('h1').attributes('id'))
    expect(w!.find('h1').text()).toBe('归档')
    expect(document.title).toBe('归档 — Markr')
  })

  it('shows 处理中 and 处理失败 overlays with the backend error', async () => {
    fallback = {
      ok: true,
      data: page([
        owner('p1', { status: 'processing', media: null }),
        owner('p2', { status: 'uploading', media: null }),
        owner('p3', { status: 'failed', error: '无法解码图片', media: null }),
        owner('p4'),
      ]),
    }
    await open()
    expect(tile('p1').text()).toContain('处理中')
    expect(tile('p2').text()).toContain('处理中')
    expect(tile('p3').text()).toContain('处理失败')
    expect(tile('p3').text()).toContain('无法解码图片')
    expect(tile('p4').find('[data-status]').exists()).toBe(false)
    // The overlay text is announced as the tile's description.
    const desc = tile('p3').attributes('aria-describedby')!
    expect(document.getElementById(desc)!.textContent).toContain('处理失败')
  })

  it('shows the empty state with the upload slot', async () => {
    await open()
    expect(w!.text()).toContain('还没有照片')
    expect(w!.find('[data-upload-slot]').exists()).toBe(true)
  })

  it('shows a filtered empty state without the upload slot', async () => {
    await open('/me?year=2025')
    expect(w!.text()).toContain('没有符合筛选的照片')
    expect(w!.text()).not.toContain('还没有照片')
  })

  it('shows WallStatus with a retry on network error', async () => {
    fallback = { ok: false, status: 0 }
    await open()
    expect(w!.text()).toContain('网络连接出了问题')
    fallback = { ok: true, data: page([owner('p1')]) }
    await button('重试')!.trigger('click')
    await flushPromises()
    expect(tileIds()).toEqual(['p1'])
  })

  it('ignores an aborted read', async () => {
    fallback = { ok: false, status: -1 }
    await open()
    expect(w!.text()).not.toContain('网络连接出了问题')
  })
})

describe('ArchiveRoute paging', () => {
  it('appends the next page from the sentinel and the button through one guarded more()', async () => {
    replies[key({}, null)] = { ok: true, data: page([owner('p1'), owner('p2')], 'k1') }
    let release!: (r: Result<ArchivePage>) => void
    replies[key({}, 'k1')] = new Promise((r) => (release = r))
    await open()
    const io = observers.at(-1)!
    io.fire()
    io.fire()
    await button('载入更多')?.trigger('click')
    expect(calls.filter((c) => c.cursor === 'k1').length).toBe(1)
    release({ ok: true, data: page([owner('p2'), owner('p3')], null) })
    await flushPromises()
    expect(tileIds()).toEqual(['p1', 'p2', 'p3'])
    expect(button('载入更多')).toBeUndefined()
  })

  it('shows a retry when the next page fails', async () => {
    replies[key({}, null)] = { ok: true, data: page([owner('p1')], 'k1') }
    replies[key({}, 'k1')] = { ok: false, status: 0 }
    await open()
    await button('载入更多')!.trigger('click')
    await flushPromises()
    expect(button('重试')).toBeTruthy()
    replies[key({}, 'k1')] = { ok: true, data: page([owner('p2')]) }
    await button('重试')!.trigger('click')
    await flushPromises()
    expect(tileIds()).toEqual(['p1', 'p2'])
  })
})

describe('ArchiveRoute filters', () => {
  it('reads filters from the URL', async () => {
    await open('/me?year=2025&status=failed&in_collection=false&camera=X100V&focal_min=20')
    expect(calls[0]!.q).toEqual({ year: 2025, camera: 'X100V', focalMin: 20, inCollection: false, status: 'failed' })
    expect((w!.find('select[name="year"]').element as HTMLSelectElement).value).toBe('2025')
    expect((w!.find('select[name="status"]').element as HTMLSelectElement).value).toBe('failed')
    expect((w!.find('input[name="unused"]').element as HTMLInputElement).checked).toBe(true)
    expect((w!.find('input[name="focal_min"]').element as HTMLInputElement).value).toBe('20')
  })

  it('offers facets with counts and the three status options', async () => {
    await open()
    const years = w!.find('select[name="year"]').findAll('option').map((o) => o.text())
    expect(years).toEqual(['全部', '2026（3）', '2025（1）'])
    const cams = w!.find('select[name="camera"]').findAll('option').map((o) => o.text())
    expect(cams).toEqual(['全部', 'X100V（4）'])
    const st = w!.find('select[name="status"]').findAll('option')
    expect(st.map((o) => o.text())).toEqual(['全部', '处理中', '失败'])
    expect(st.map((o) => o.attributes('value'))).toEqual(['', 'processing', 'failed'])
    // Every control has a visible label (the hidden file input is reached through 上传).
    for (const el of w!.findAll('select, input:not([type="file"])')) {
      const id = el.attributes('id')!
      expect(w!.find(`label[for="${id}"]`).text().length).toBeGreaterThan(0)
    }
  })

  it('pushes the query, aborts the old request and reloads from the first page', async () => {
    let release!: (r: Result<ArchivePage>) => void
    replies[key({}, null)] = new Promise((r) => (release = r))
    replies[key({ status: 'failed' }, null)] = { ok: true, data: page([owner('p9')]) }
    await open()
    const replace = vi.spyOn(router, 'replace')
    const push = vi.spyOn(router, 'push')
    const first = calls[0]!
    // The first page is still pending, so use the static status options.
    await w!.find('select[name="status"]').setValue('failed')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ status: 'failed' })
    expect(push).toHaveBeenCalledWith({ query: { status: 'failed' } })
    expect(replace).not.toHaveBeenCalled()
    expect(first.signal!.aborted).toBe(true)
    expect(calls.at(-1)).toMatchObject({ q: { status: 'failed' }, cursor: null })
    // The stale first reply never overwrites the filtered result.
    release({ ok: true, data: page([owner('stale')]) })
    await flushPromises()
    expect(tileIds()).not.toContain('stale')
  })

  it('maps the status, unused and focal controls to the query', async () => {
    await open()
    await w!.find('select[name="status"]').setValue('processing')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ status: 'processing' })
    await w!.find('input[name="unused"]').setValue(true)
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ status: 'processing', in_collection: 'false' })
    await w!.find('input[name="focal_max"]').setValue('50')
    await w!.find('input[name="focal_max"]').trigger('change')
    await flushPromises()
    expect(router.currentRoute.value.query).toMatchObject({ focal_max: '50' })
    await button('清除筛选')!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
    expect(calls.at(-1)!.q).toEqual({})
  })

  it('a year change pushes a history entry, not a replace', async () => {
    await open()
    const replace = vi.spyOn(router, 'replace')
    const push = vi.spyOn(router, 'push')
    await w!.find('select[name="year"]').setValue('2025')
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({ query: { year: '2025' } })
    expect(replace).not.toHaveBeenCalled()
    expect(router.currentRoute.value.query).toEqual({ year: '2025' })
    // Back steps to the unfiltered archive, still on /me.
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/me')
    expect((w!.find('select[name="year"]').element as HTMLSelectElement).value).toBe('')
  })

  it('choosing the same filters twice adds one history entry', async () => {
    await open()
    const push = vi.spyOn(router, 'push')
    const year = w!.find('select[name="year"]')
    await year.setValue('2025')
    await flushPromises()
    await year.setValue('2025')
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(1)
    // Clearing with nothing set, or re-choosing 全部 at /me, pushes nothing either.
    router.back()
    await flushPromises()
    await w!.find('select[name="year"]').setValue('')
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.fullPath).toBe('/me')
  })

  it('a focal input pushes only on change, once per commit', async () => {
    await open()
    const push = vi.spyOn(router, 'push')
    const fmin = w!.find('input[name="focal_min"]')
    const el = fmin.element as HTMLInputElement
    // Keystrokes fire input events only.
    el.value = '3'
    await fmin.trigger('input')
    el.value = '35'
    await fmin.trigger('input')
    await flushPromises()
    expect(push).not.toHaveBeenCalled()
    expect(router.currentRoute.value.query).toEqual({})
    await fmin.trigger('change')
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({ query: { focal_min: '35' } })
    // Committing the same value again (blur after Enter) adds nothing.
    await fmin.trigger('change')
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('a route query change (Back/Forward) reloads from the first page and aborts the old request', async () => {
    replies[key({ year: 2025 }, null)] = { ok: true, data: page([owner('a1')], 'k1') }
    await open('/me?year=2025')
    expect(tileIds()).toEqual(['a1'])
    await router.push('/me?year=2025&camera=X100V')
    let release!: (r: Result<ArchivePage>) => void
    replies[key({ year: 2025, camera: 'X100V' }, null)] = new Promise((r) => (release = r))
    // Re-enter the camera query so its reply is still pending when we go back.
    await router.push('/me?year=2025')
    await flushPromises()
    await router.push('/me?year=2025&camera=X100V')
    const pending = calls.at(-1)!
    expect(pending).toMatchObject({ q: { year: 2025, camera: 'X100V' }, cursor: null })
    expect((w!.find('select[name="camera"]').element as HTMLSelectElement).value).toBe('X100V')
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ year: '2025' })
    expect(pending.signal!.aborted).toBe(true)
    expect(calls.at(-1)).toMatchObject({ q: { year: 2025 }, cursor: null })
    expect((w!.find('select[name="camera"]').element as HTMLSelectElement).value).toBe('')
    expect((w!.find('select[name="year"]').element as HTMLSelectElement).value).toBe('2025')
    expect(tileIds()).toEqual(['a1'])
    expect(button('载入更多')).toBeDefined()
    // The late reply for the abandoned query never lands.
    release({ ok: true, data: page([owner('late')]) })
    await flushPromises()
    expect(tileIds()).toEqual(['a1'])
  })

  it('a query change resets the cursor and the list', async () => {
    replies[key({}, null)] = { ok: true, data: page([owner('p1')], 'k1') }
    replies[key({}, 'k1')] = { ok: true, data: page([owner('p2')], 'k2') }
    replies[key({ year: 2025 }, null)] = { ok: true, data: page([owner('y1')], null) }
    await open()
    await button('载入更多')!.trigger('click')
    await flushPromises()
    expect(tileIds()).toEqual(['p1', 'p2'])
    await w!.find('select[name="year"]').setValue('2025')
    await flushPromises()
    expect(tileIds()).toEqual(['y1'])
    expect(button('载入更多')).toBeUndefined()
    router.back()
    await flushPromises()
    expect(calls.at(-1)).toMatchObject({ q: {}, cursor: null })
    expect(tileIds()).toEqual(['p1'])
  })

  it('opening the detail panel adds no history entry', async () => {
    replies[key({}, null)] = { ok: true, data: page([owner('p1')]) }
    await open()
    const push = vi.spyOn(router, 'push')
    const replace = vi.spyOn(router, 'replace')
    await tile('p1').trigger('click')
    await flushPromises()
    expect(w!.find('aside').exists()).toBe(true)
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('aborts an in-flight next page when the filter changes', async () => {
    replies[key({}, null)] = { ok: true, data: page([owner('p1')], 'k1') }
    let release!: (r: Result<ArchivePage>) => void
    replies[key({}, 'k1')] = new Promise((r) => (release = r))
    await open()
    await button('载入更多')!.trigger('click')
    const more = calls.at(-1)!
    await w!.find('select[name="year"]').setValue('2025')
    await flushPromises()
    expect(more.signal!.aborted).toBe(true)
    release({ ok: true, data: page([owner('late')]) })
    await flushPromises()
    expect(tileIds()).not.toContain('late')
  })
})

describe('ArchiveRoute panel', () => {
  beforeEach(() => {
    fallback = {
      ok: true,
      data: page([owner('p1'), owner('p2', { status: 'failed', error: '无法解码图片' }), owner('p3')]),
    }
  })

  it('opens a labelled aside with image, EXIF, public fields and delete', async () => {
    await open()
    await tile('p1').trigger('click')
    const aside = w!.find('aside')
    expect(aside.exists()).toBe(true)
    expect(document.getElementById(aside.attributes('aria-labelledby')!)!.textContent).toBe('标题p1')
    expect(aside.find('img').exists()).toBe(true)
    expect(aside.text()).toContain('机身')
    expect(aside.text()).toContain('X100V')
    expect(aside.text()).toContain('f/2')
    expect(aside.text()).toContain('ISO 200')
    const chips = aside.findAll('[data-public-field]').map((c) => c.text())
    expect(chips).toEqual(['光圈', '感光度'])
    expect(aside.text()).not.toContain('个合集中')
    expect(aside.findAll('button').some((b) => b.text() === '删除')).toBe(true)
    expect(tile('p1').attributes('aria-expanded')).toBe('true')
    expect(tile('p2').attributes('aria-expanded')).toBe('false')
  })

  it('shows the failure reason in the panel', async () => {
    await open()
    await tile('p2').trigger('click')
    expect(w!.find('aside').text()).toContain('处理失败')
    expect(w!.find('aside').text()).toContain('无法解码图片')
  })

  it('closes on Esc and on 关闭, returning focus to the tile', async () => {
    await open()
    ;(tile('p2').element as HTMLElement).focus()
    await tile('p2').trigger('click')
    await nextTick()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(w!.find('aside').exists()).toBe(false)
    expect(focusedId()).toBe('p2')

    await tile('p3').trigger('click')
    await button('关闭')!.trigger('click')
    await flushPromises()
    expect(w!.find('aside').exists()).toBe(false)
    expect(focusedId()).toBe('p3')
  })

  it('switches photos when another tile is clicked', async () => {
    await open()
    await tile('p1').trigger('click')
    await tile('p3').trigger('click')
    expect(w!.findAll('aside').length).toBe(1)
    expect(w!.find('aside h2').text()).toBe('标题p3')
  })
})

describe('ArchiveRoute delete', () => {
  beforeEach(() => {
    fallback = { ok: true, data: page([owner('p1'), owner('p2'), owner('p3')]) }
  })

  async function openDelete(id: string) {
    await open()
    await tile(id).trigger('click')
    await button('删除')!.trigger('click')
    await flushPromises()
  }

  it('confirms in a dialog with focus on 取消, then deletes and focuses the next tile', async () => {
    api.deletePhoto.mockResolvedValue({ ok: true, status: 204, data: null } satisfies WriteResult<unknown>)
    await openDelete('p2')
    const dialog = w!.find('dialog')
    expect(dialog.attributes('open')).toBeDefined()
    expect(dialog.text()).toContain('如果它在已发布的合集中，访客会立刻看不到。')
    expect(document.getElementById(dialog.attributes('aria-labelledby')!)!.textContent).toBe('删除这张照片？')
    expect((document.activeElement as HTMLElement).textContent).toBe('取消')
    await dialog.findAll('button').find((b) => b.text() === '删除')!.trigger('click')
    await flushPromises()
    expect(api.deletePhoto).toHaveBeenCalledWith('p2')
    expect(tileIds()).toEqual(['p1', 'p3'])
    expect(w!.find('aside').exists()).toBe(false)
    expect(w!.find('dialog').attributes('open')).toBeUndefined()
    expect(focusedId()).toBe('p3')
  })

  it('focuses the previous tile when the last one is deleted', async () => {
    api.deletePhoto.mockResolvedValue({ ok: true, status: 204, data: null })
    await openDelete('p3')
    await w!.find('dialog').findAll('button').find((b) => b.text() === '删除')!.trigger('click')
    await flushPromises()
    expect(tileIds()).toEqual(['p1', 'p2'])
    expect(focusedId()).toBe('p2')
  })

  it('focuses the heading when the archive becomes empty', async () => {
    fallback = { ok: true, data: page([owner('p1')]) }
    api.deletePhoto.mockResolvedValue({ ok: true, status: 204, data: null })
    await openDelete('p1')
    await w!.find('dialog').findAll('button').find((b) => b.text() === '删除')!.trigger('click')
    await flushPromises()
    expect(tileIds()).toEqual([])
    expect(w!.text()).toContain('还没有照片')
    expect(document.activeElement).toBe(w!.find('h1').element)
  })

  it('shows the server message in the dialog on failure and keeps the photo', async () => {
    api.deletePhoto.mockResolvedValue({ ok: false, status: 409, message: '照片正在处理，稍后再删。' })
    await openDelete('p2')
    await w!.find('dialog').findAll('button').find((b) => b.text() === '删除')!.trigger('click')
    await flushPromises()
    expect(w!.find('dialog').attributes('open')).toBeDefined()
    expect(w!.find('dialog [role="alert"]').text()).toBe('照片正在处理，稍后再删。')
    expect(tileIds()).toEqual(['p1', 'p2', 'p3'])
  })

  it('cancel closes the dialog, keeps the panel and returns focus to 删除', async () => {
    await openDelete('p2')
    await w!.find('dialog').findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    await flushPromises()
    expect(w!.find('dialog').attributes('open')).toBeUndefined()
    expect(api.deletePhoto).not.toHaveBeenCalled()
    expect(w!.find('aside').exists()).toBe(true)
    expect((document.activeElement as HTMLElement).textContent).toBe('删除')
  })

  it('Esc inside the dialog cancels it without closing the panel', async () => {
    await openDelete('p2')
    w!.find('dialog').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(w!.find('dialog').attributes('open')).toBeUndefined()
    expect(w!.find('aside').exists()).toBe(true)
  })
})

class FakeXHR {
  static all: FakeXHR[] = []
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  withCredentials = false
  status = 0
  aborted = false
  constructor() {
    FakeXHR.all.push(this)
  }
  open() {}
  setRequestHeader() {}
  send() {}
  abort() {
    this.aborted = true
    this.onabort?.()
  }
}

describe('ArchiveRoute uploads', () => {
  beforeEach(() => {
    FakeXHR.all = []
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
    api.createUpload.mockImplementation(async (f: { filename: string }) => ({
      ok: true,
      status: 201,
      data: { photoId: `n-${f.filename}`, upload: { url: 'https://s3/x', method: 'PUT', headers: {} }, expiresAt: 0 },
    }))
    api.completeUpload.mockImplementation(async (id: string) => ({ ok: true, status: 200, data: owner(id, { status: 'ready' }) }))
  })

  const input = () => w!.find('input[type="file"]')
  function choose(files: File[]) {
    const el = input().element as HTMLInputElement
    Object.defineProperty(el, 'files', { value: files, configurable: true })
    return input().trigger('change')
  }
  const jpg = (name: string) => new File(['x'], name, { type: 'image/jpeg' })

  it('has 上传 in the header and the empty state, opening a hidden multi-file input', async () => {
    await open()
    const el = input().element as HTMLInputElement
    expect(el.multiple).toBe(true)
    expect(el.accept).toBe('image/jpeg,image/png,image/webp')
    expect(el.hidden || el.getAttribute('tabindex') === '-1').toBe(true)
    const ups = w!.findAll('button').filter((b) => b.text() === '上传')
    expect(ups.length).toBe(2)
    expect(w!.find('[data-upload-slot]').find('button').text()).toBe('上传')
    const click = vi.spyOn(el, 'click')
    await ups[0]!.trigger('click')
    expect(click).toHaveBeenCalled()
  })

  it('prepends a finished photo to the grid, de-duplicated by id', async () => {
    fallback = { ok: true, data: page([owner('p1'), owner('n-a.jpg')]) }
    await open()
    await choose([jpg('a.jpg'), jpg('b.jpg')])
    await flushPromises()
    expect(FakeXHR.all.length).toBe(2)
    for (const x of FakeXHR.all) {
      x.status = 200
      x.onload!()
    }
    await flushPromises()
    expect(tileIds()).toEqual(['n-b.jpg', 'n-a.jpg', 'p1'])
    expect(w!.find('[aria-live="polite"]').text()).toBe('2 张完成')
  })

  it('shows a tile from the empty state after upload', async () => {
    await open()
    await choose([jpg('a.jpg')])
    await flushPromises()
    FakeXHR.all[0]!.status = 200
    FakeXHR.all[0]!.onload!()
    await flushPromises()
    expect(tileIds()).toEqual(['n-a.jpg'])
  })

  it('shows a 松开以上传 overlay while files are dragged and adds dropped files', async () => {
    await open()
    const overlay = () => w!.find('[data-drop-overlay]')
    expect(overlay().exists()).toBe(false)
    const dt = { types: ['Files'], files: [jpg('d.jpg')] }
    const enter = new Event('dragenter', { cancelable: true }) as DragEvent
    Object.defineProperty(enter, 'dataTransfer', { value: dt })
    document.dispatchEvent(enter)
    await nextTick()
    expect(overlay().text()).toBe('松开以上传')
    expect(overlay().attributes('aria-hidden')).toBe('true')
    const over = new Event('dragover', { cancelable: true }) as DragEvent
    Object.defineProperty(over, 'dataTransfer', { value: dt })
    document.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    const drop = new Event('drop', { cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: dt })
    document.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    await flushPromises()
    expect(overlay().exists()).toBe(false)
    expect(api.createUpload).toHaveBeenCalledWith(expect.objectContaining({ filename: 'd.jpg' }))
  })

  it('ignores drags that carry no files', async () => {
    await open()
    const enter = new Event('dragenter', { cancelable: true }) as DragEvent
    Object.defineProperty(enter, 'dataTransfer', { value: { types: ['text/plain'], files: [] } })
    document.dispatchEvent(enter)
    await nextTick()
    expect(w!.find('[data-drop-overlay]').exists()).toBe(false)
  })

  it('aborts the in-flight PUT and drops beforeunload on unmount', async () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    await open()
    await choose([jpg('a.jpg')])
    await flushPromises()
    w!.unmount()
    w = null
    expect(FakeXHR.all[0]!.aborted).toBe(true)
    expect(remove.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(true)
    remove.mockRestore()
  })
})
