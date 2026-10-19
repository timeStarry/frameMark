import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { ArchivePage, ArchiveQuery, OwnerPhoto } from '../api/types'
import { media } from '../viewer/testFixtures'
import { FakeIO } from '../routes/wallTestUtils'
import { PHOTO_TYPE, readPhotos } from './dnd'
import { DTStub, drag } from './deskTestUtils'

const api = vi.hoisted(() => ({ getArchive: vi.fn() }))
vi.mock('../api/me', () => api)

import DeskArchive from './DeskArchive.vue'

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
    createdAt: 1,
    publicFields: [],
    histogramPublic: false,
    originalDownload: false,
    exif: null,
    media: media(id),
    ...over,
  }
}
const FACETS: ArchivePage['facets'] = { years: [{ year: 2026, count: 3 }], cameras: [], lenses: [] }
const page = (items: OwnerPhoto[], nextCursor: string | null = null): ArchivePage => ({ items, nextCursor, facets: FACETS })

let calls: { q: ArchiveQuery; cursor: string | null }[] = []
let observers: FakeIO[] = []
let w: VueWrapper | null = null

beforeEach(() => {
  calls = []
  observers = []
  vi.stubGlobal(
    'IntersectionObserver',
    class extends FakeIO {
      constructor(cb: IntersectionObserverCallback) {
        super(cb)
        observers.push(this)
      }
    },
  )
  api.getArchive.mockReset().mockImplementation(async (q: ArchiveQuery, cursor: string | null) => {
    calls.push({ q, cursor })
    if (cursor === 'k2') return { ok: true, data: page([owner('d'), owner('a')]) }
    return { ok: true, data: page([owner('a'), owner('b'), owner('c'), owner('x', { status: 'processing' })], 'k2') }
  })
})
afterEach(() => {
  w?.unmount()
  w = null
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function open(inSequence: string[] = []) {
  w = mount(DeskArchive, { props: { inSequence: new Set(inSequence) }, attachTo: document.body })
  await flushPromises()
  return w
}
const tiles = (wr: VueWrapper) => wr.findAll('[role="option"]')
const added = (wr: VueWrapper) => ((wr.emitted('add') ?? []) as [{ id: string }[]][]).map(([ps]) => ps.map((p) => p.id))

describe('DeskArchive', () => {
  it('asks for ready photos only and keeps the filters out of the URL', async () => {
    const wr = await open()
    expect(calls).toEqual([{ q: { status: 'ready' }, cursor: null }])
    expect(tiles(wr).map((t) => t.attributes('data-photo-id'))).toEqual(['a', 'b', 'c'])
    // The status filter is hidden; the year filter reloads with status kept.
    expect(wr.find('select[name="status"]').exists()).toBe(false)
    await wr.find('select[name="year"]').setValue('2026')
    await flushPromises()
    expect(calls.at(-1)).toEqual({ q: { year: 2026, status: 'ready' }, cursor: null })
  })

  it('dims photos already in the sequence and marks them 已在序列', async () => {
    const wr = await open(['b'])
    const b = tiles(wr)[1]!
    expect(b.classes()).toContain('used')
    expect(b.find('.badge').text()).toBe('已在序列')
    expect(b.attributes('aria-label')).toBe('标题b，已在序列')
    expect(tiles(wr)[0]!.classes()).not.toContain('used')
    expect(tiles(wr)[0]!.attributes('aria-label')).toBe('标题a')
  })

  it('Enter on a tile adds it; the 加入 button adds the selection', async () => {
    const wr = await open(['a'])
    await tiles(wr)[0]!.trigger('keydown', { key: 'Enter' })
    // Already-used photos can be added again.
    expect(added(wr)).toEqual([['a']])
    expect(wr.find('.add').attributes('disabled')).toBeDefined()
  })

  it('Space toggles multi-select, then Enter adds every selected photo in archive order', async () => {
    const wr = await open()
    await tiles(wr)[2]!.trigger('keydown', { key: ' ' })
    await tiles(wr)[0]!.trigger('keydown', { key: ' ' })
    expect(tiles(wr).map((t) => t.attributes('aria-selected'))).toEqual(['true', 'false', 'true'])
    expect(wr.find('.add').text()).toBe('加入（2）')
    await tiles(wr)[1]!.trigger('keydown', { key: 'Enter' })
    expect(added(wr)).toEqual([['a', 'c']])
    // Adding clears the selection.
    expect(tiles(wr).every((t) => t.attributes('aria-selected') === 'false')).toBe(true)
  })

  it('Shift click selects a range, ⌘ click toggles, then 加入 adds them', async () => {
    const wr = await open()
    await tiles(wr)[0]!.trigger('click')
    await tiles(wr)[2]!.trigger('click', { shiftKey: true })
    expect(tiles(wr).map((t) => t.attributes('aria-selected'))).toEqual(['true', 'true', 'true'])
    await tiles(wr)[1]!.trigger('click', { metaKey: true })
    expect(tiles(wr).map((t) => t.attributes('aria-selected'))).toEqual(['true', 'false', 'true'])
    await wr.find('.add').trigger('click')
    expect(added(wr)).toEqual([['a', 'c']])
  })

  it('tiles drag as application/x-markr-photo, carrying the selection', async () => {
    const wr = await open()
    expect(tiles(wr)[0]!.attributes('draggable')).toBe('true')
    const one = new DTStub()
    drag(tiles(wr)[1]!.element, 'dragstart', one)
    expect(one.types).toEqual([PHOTO_TYPE])
    expect(readPhotos(one as unknown as DataTransfer).map((p) => p.id)).toEqual(['b'])
    await tiles(wr)[0]!.trigger('keydown', { key: ' ' })
    await tiles(wr)[2]!.trigger('keydown', { key: ' ' })
    const many = new DTStub()
    drag(tiles(wr)[2]!.element, 'dragstart', many)
    expect(readPhotos(many as unknown as DataTransfer).map((p) => p.id)).toEqual(['a', 'c'])
  })

  it('pages with 载入更多 and the sentinel through one guarded more()', async () => {
    const wr = await open()
    observers.at(-1)!.fire()
    observers.at(-1)!.fire()
    await flushPromises()
    expect(calls.filter((c) => c.cursor === 'k2')).toHaveLength(1)
    expect(tiles(wr).map((t) => t.attributes('data-photo-id'))).toEqual(['a', 'b', 'c', 'd'])
    expect(wr.text()).not.toContain('载入更多')
  })

  it('focusFirst focuses the first tile', async () => {
    const wr = await open()
    await (wr.vm as unknown as { focusFirst(): Promise<void> }).focusFirst()
    expect(document.activeElement).toBe(tiles(wr)[0]!.element)
  })
})
