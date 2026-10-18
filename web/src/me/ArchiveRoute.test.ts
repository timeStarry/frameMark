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
}))
vi.mock('../api/me', () => api)

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
    // Every control has a visible label.
    for (const el of w!.findAll('select, input')) {
      const id = el.attributes('id')!
      expect(w!.find(`label[for="${id}"]`).text().length).toBeGreaterThan(0)
    }
  })

  it('replaces the query, aborts the old request and reloads from the first page', async () => {
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
    expect(replace).toHaveBeenCalledWith({ query: { status: 'failed' } })
    expect(push).not.toHaveBeenCalled()
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
