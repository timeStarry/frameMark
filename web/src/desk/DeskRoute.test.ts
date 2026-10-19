import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { computed, nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import type { ArchivePage, Collection, OwnerPhoto } from '../api/types'
import { collection, fullFrame, media, photo } from '../viewer/testFixtures'
import { FakeIO } from '../routes/wallTestUtils'
import { insertPhotos, type Seq } from './sequence'
import { deskPhoto } from './deskTestUtils'
import Viewer from '../viewer/Viewer.vue'

const api = vi.hoisted(() => ({ getArchive: vi.fn() }))
vi.mock('../api/me', () => api)

type Fake = ReturnType<typeof makeDesk>
const holder = vi.hoisted(() => ({ desk: null as unknown }))
vi.mock('./useDesk', () => ({ useDesk: () => holder.desk }))

function makeDesk(initial: Seq) {
  const seq = ref<Seq>(initial)
  const state = ref<'loading' | 'ready' | 'missing' | 'error'>('ready')
  const exposureOpen = ref(false)
  const checking = ref(false)
  const saveState = ref<'saved' | 'saving' | 'unsaved' | 'error' | 'conflict'>('saved')
  const errorMessage = ref('')
  const preview: Collection = collection([fullFrame(photo('p1'))])
  const confirm = vi.fn()
  const cancel = vi.fn()
  const d = {
    state: computed(() => state.value),
    collection: computed(() => null),
    fields: computed(() => ({ title: '海边', intro: '', visibility: 'private', distribute: false, originalDownload: false, license: null, aiDeclaration: null, coverPhotoId: null })),
    seq: computed(() => seq.value),
    selected: ref(0),
    saveState: computed(() => saveState.value),
    errorMessage: computed(() => errorMessage.value),
    exposure: computed(() =>
      exposureOpen.value ? { open: true, changes: [{ kind: 'photos', detail: '加入了一张照片' }], confirm, cancel } : null,
    ),
    conflict: computed(() => null),
    backupOffer: computed(() => null),
    previewCollection: computed(() => preview),
    canUndo: computed(() => true),
    canRedo: computed(() => true),
    checking: computed(() => checking.value),
    retry: vi.fn(),
    applySeq: vi.fn((next: Seq, _kind: 'structure') => {
      seq.value = next
    }),
    applyFields: vi.fn(),
    setPhotoMeta: vi.fn(),
    setOverride: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    publish: vi.fn(),
    confirmPublish: vi.fn(),
    unpublish: vi.fn(),
    remove: vi.fn(),
    dispose: vi.fn(),
    confirm,
    cancel,
    _seq: seq,
    _state: state,
    _exposure: exposureOpen,
    _checking: checking,
    _saveState: saveState,
    _errorMessage: errorMessage,
    _preview: preview,
  }
  return d
}

import DeskRoute from './DeskRoute.vue'

function owner(id: string): OwnerPhoto {
  return {
    id, status: 'ready', error: null, title: `标题${id}`, caption: '', width: 6000, height: 4000, format: 'jpeg',
    createdAt: 1, publicFields: [], histogramPublic: false, originalDownload: false, exif: null, media: media(id),
  }
}
const page = (items: OwnerPhoto[]): ArchivePage => ({ items, nextCursor: null, facets: { years: [], cameras: [], lenses: [] } })

let desk: Fake
let router: Router
let w: VueWrapper | null = null

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', FakeIO)
  api.getArchive.mockReset().mockResolvedValue({ ok: true, data: page([owner('a'), owner('b'), owner('c')]) })
  desk = makeDesk(insertPhotos([], 0, [deskPhoto('a'), deskPhoto('x')]))
  holder.desk = desk
})
afterEach(() => {
  w?.unmount()
  w = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function open() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] })
  await router.push('/me/c/c1')
  w = mount(DeskRoute, { props: { id: 'c1' }, global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return w
}
const frames = (wr: VueWrapper) => wr.findAll('[role="listitem"]')
const tiles = (wr: VueWrapper) => wr.findAll('[role="option"]')
const live = (wr: VueWrapper) => wr.find('[data-desk-live]').text()
const seqIds = () => desk._seq.value.map((f) => f.photos.map((p) => p.id).join('+'))
const key = (target: EventTarget, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

describe('DeskRoute', () => {
  it('shows the top bar, the three columns and a status save state', async () => {
    const wr = await open()
    expect(wr.find('h1').text()).toBe('海边')
    expect(document.title).toBe('海边 — Markr')
    expect(wr.find('.back').attributes('href')).toBe('/me/collections')
    expect(wr.find('.save').attributes('role')).toBe('status')
    expect(wr.find('.save').text()).toBe('已保存')
    expect(wr.find('.desk-archive').exists()).toBe(true)
    expect(wr.find('[role="list"]').exists()).toBe(true)
    expect(wr.find('[data-desk-preview]').exists()).toBe(true)
  })

  it('archive Enter appends a full frame through applySeq and announces it', async () => {
    const wr = await open()
    await tiles(wr)[1]!.trigger('keydown', { key: 'Enter' })
    expect(desk.applySeq).toHaveBeenCalledTimes(1)
    expect(desk.applySeq.mock.calls[0]![1]).toBe('structure')
    expect(seqIds()).toEqual(['a', 'x', 'b'])
    expect(desk._seq.value[2]!.layout).toBe('full')
    await flushPromises()
    expect(live(wr)).toBe('已加入到第 3 帧')
  })

  it('Space multi-select then Enter adds one frame per photo; used photos are marked', async () => {
    const wr = await open()
    expect(tiles(wr)[0]!.find('.badge').text()).toBe('已在序列')
    expect(tiles(wr)[1]!.find('.badge').exists()).toBe(false)
    await tiles(wr)[1]!.trigger('keydown', { key: ' ' })
    await tiles(wr)[2]!.trigger('keydown', { key: ' ' })
    await tiles(wr)[2]!.trigger('keydown', { key: 'Enter' })
    expect(seqIds()).toEqual(['a', 'x', 'b', 'c'])
    await nextTick()
    expect(tiles(wr)[1]!.find('.badge').text()).toBe('已在序列')
  })

  it('⌥↓ moves a frame and announces 已移到第 N 帧', async () => {
    const wr = await open()
    await frames(wr)[0]!.trigger('keydown', { key: 'ArrowDown', altKey: true })
    expect(seqIds()).toEqual(['x', 'a'])
    await flushPromises()
    expect(live(wr)).toBe('已移到第 2 帧')
    expect(wr.find('[data-desk-live]').attributes('aria-live')).toBe('polite')
  })

  it('Delete removes the frame and shows the undo toast for 8 seconds', async () => {
    vi.useFakeTimers()
    const wr = await open()
    await frames(wr)[1]!.trigger('keydown', { key: 'Delete' })
    expect(seqIds()).toEqual(['a'])
    await nextTick()
    await Promise.resolve()
    await nextTick()
    expect(live(wr)).toBe('已删除第 2 帧')
    expect(wr.find('[data-undo-toast]').text()).toContain('已删除一帧')
    vi.advanceTimersByTime(7999)
    await nextTick()
    expect(wr.find('[data-undo-toast]').exists()).toBe(true)
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(wr.find('[data-undo-toast]').exists()).toBe(false)
  })

  it('the toast 撤销 calls desk.undo', async () => {
    const wr = await open()
    await frames(wr)[0]!.trigger('keydown', { key: 'Backspace' })
    await wr.find('[data-undo-toast] button').trigger('click')
    expect(desk.undo).toHaveBeenCalledTimes(1)
    expect(wr.find('[data-undo-toast]').exists()).toBe(false)
  })

  it('⌘Z / Ctrl+Z undo and ⇧⌘Z / Ctrl+Y redo, except in text inputs', async () => {
    const wr = await open()
    key(document.body, { key: 'z', metaKey: true })
    key(frames(wr)[0]!.element, { key: 'z', ctrlKey: true })
    expect(desk.undo).toHaveBeenCalledTimes(2)
    key(document.body, { key: 'z', metaKey: true, shiftKey: true })
    key(document.body, { key: 'y', ctrlKey: true })
    expect(desk.redo).toHaveBeenCalledTimes(2)
    const input = wr.find('input[name="focal_min"]').element
    key(input, { key: 'z', metaKey: true })
    key(input, { key: 'y', ctrlKey: true })
    const ta = document.createElement('textarea')
    wr.element.appendChild(ta)
    key(ta, { key: 'z', ctrlKey: true })
    expect(desk.undo).toHaveBeenCalledTimes(2)
    expect(desk.redo).toHaveBeenCalledTimes(2)
  })

  it('passes desk.previewCollection to the Viewer in preview mode; its emits do not navigate', async () => {
    const wr = await open()
    const v = wr.findComponent(Viewer)
    expect(v.props('mode')).toBe('preview')
    expect(v.props('neighbors')).toBeNull()
    expect(v.props('collection')).toStrictEqual(desk._preview)
    expect(v.props('initialFrame')).toBe(1)
    const push = vi.spyOn(router, 'push')
    const replace = vi.spyOn(router, 'replace')
    v.vm.$emit('exit')
    v.vm.$emit('frame', 2)
    v.vm.$emit('navigate', 1)
    v.vm.$emit('jump', 'c9')
    await flushPromises()
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/me/c/c1')
  })

  it('Enter on a frame opens the 属性 slot; Esc returns to the preview and focuses the frame', async () => {
    const wr = await open()
    const second = frames(wr)[1]!
    ;(second.element as HTMLElement).focus()
    await second.trigger('keydown', { key: 'Enter' })
    expect(desk.selected.value).toBe(1)
    expect(wr.find('[data-desk-props] h2').text()).toBe('属性')
    expect(wr.find('[data-desk-preview]').exists()).toBe(false)
    key(document.body, { key: 'Escape' })
    await flushPromises()
    expect(wr.find('[data-desk-preview]').exists()).toBe(true)
    expect(document.activeElement).toBe(frames(wr)[1]!.element)
    expect(wr.findComponent(Viewer).props('initialFrame')).toBe(2)
  })

  it('从归档添加 focuses the archive', async () => {
    const wr = await open()
    await wr.find('[data-gap="1"] .plus').trigger('click')
    await wr.findAll('[data-gap="1"] .menu button')[1]!.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(tiles(wr)[0]!.element)
  })

  it('an open exposure check shows the interim prompt wired to confirm/cancel', async () => {
    const wr = await open()
    desk._exposure.value = true
    await nextTick()
    const box = wr.find('[data-desk-exposure]')
    expect(box.text()).toContain('加入了一张照片')
    const [cancel, confirm] = box.findAll('button')
    await confirm!.trigger('click')
    await cancel!.trigger('click')
    expect(desk.confirm).toHaveBeenCalledTimes(1)
    expect(desk.cancel).toHaveBeenCalledTimes(1)
  })

  it('locks structural edits and undo/redo while a check is in flight or the prompt is open', async () => {
    for (const lock of ['checking', 'exposure'] as const) {
      const wr = await open()
      if (lock === 'checking') desk._checking.value = true
      else desk._exposure.value = true
      await nextTick()
      const btn = (t: string) => wr.findAll('.tools button').find((b) => b.text() === t)!
      expect(btn('撤销').attributes('disabled')).toBeDefined()
      expect(btn('重做').attributes('disabled')).toBeDefined()
      expect(wr.find('[data-gap="1"] .plus').attributes('disabled')).toBeDefined()
      expect(frames(wr)[0]!.attributes('draggable')).toBe('false')
      expect(tiles(wr)[0]!.attributes('draggable')).toBe('false')
      expect(wr.find('.desk-archive .add').attributes('disabled')).toBeDefined()
      await tiles(wr)[1]!.trigger('keydown', { key: 'Enter' })
      await frames(wr)[0]!.trigger('keydown', { key: 'ArrowDown', altKey: true })
      await frames(wr)[0]!.trigger('keydown', { key: 'Delete' })
      key(document.body, { key: 'z', metaKey: true })
      key(document.body, { key: 'y', ctrlKey: true })
      expect(desk.applySeq).not.toHaveBeenCalled()
      expect(desk.undo).not.toHaveBeenCalled()
      expect(desk.redo).not.toHaveBeenCalled()
      expect(wr.find('[data-undo-toast]').exists()).toBe(false)
      // Unlocking restores editing.
      desk._checking.value = false
      desk._exposure.value = false
      await nextTick()
      expect(frames(wr)[0]!.attributes('draggable')).toBe('true')
      await frames(wr)[0]!.trigger('keydown', { key: 'Delete' })
      expect(desk.applySeq).toHaveBeenCalledTimes(1)
      w!.unmount()
      w = null
      desk = makeDesk(insertPhotos([], 0, [deskPhoto('a'), deskPhoto('x')]))
      holder.desk = desk
    }
  })

  it('a save error shows 重试, which calls desk.retry', async () => {
    const wr = await open()
    expect(wr.findAll('button').some((b) => b.text() === '重试')).toBe(false)
    desk._saveState.value = 'error'
    desk._errorMessage.value = '网络连接出了问题'
    await nextTick()
    expect(wr.find('.save').text()).toContain('未保存')
    expect(wr.find('.save').text()).toContain('网络连接出了问题')
    await wr.find('button.retry').trigger('click')
    expect(desk.retry).toHaveBeenCalledTimes(1)
  })

  it('shows 找不到这个合集 for a missing collection', async () => {
    desk._state.value = 'missing'
    const wr = await open()
    expect(wr.text()).toContain('找不到这个合集')
    expect(wr.find('[role="list"]').exists()).toBe(false)
  })
})
