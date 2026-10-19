import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { computed, ref } from 'vue'
import type { CollectionFields } from '../api/types'
import { collection, fullFrame, pairFrame, photo } from '../viewer/testFixtures'
import { deskPhoto } from './deskTestUtils'
import { insertPhotos, insertText, merge, move, remove, setLayout, setText, type Seq } from './sequence'
import type { Desk } from './useDesk'
import DeskMobile from './DeskMobile.vue'

const FIELDS: CollectionFields = {
  title: '海边',
  intro: '简介',
  visibility: 'unlisted',
  distribute: false,
  originalDownload: false,
  license: null,
  aiDeclaration: null,
  coverPhotoId: null,
}

function makeDesk(initial: Seq, status: 'draft' | 'published' = 'draft') {
  const seq = ref<Seq>(initial)
  const checking = ref(false)
  const exposureOpen = ref(false)
  const saveState = ref<'saved' | 'saving' | 'unsaved' | 'error' | 'conflict'>('saved')
  const errorMessage = ref('')
  const fields = ref<CollectionFields>({ ...FIELDS })
  // The preview carries each photo's current title and caption.
  const preview = collection([fullFrame(photo('a', { title: '浪', caption: '傍晚' })), pairFrame(photo('b'), photo('c'))])
  const d = {
    state: computed(() => 'ready' as const),
    collection: computed(() => ({ status }) as unknown as Desk['collection']['value']),
    fields: computed(() => fields.value),
    seq: computed(() => seq.value),
    selected: ref(0),
    saveState: computed(() => saveState.value),
    errorMessage: computed(() => errorMessage.value),
    exposure: computed(() =>
      exposureOpen.value ? { open: true, changes: [], confirm: vi.fn(), cancel: vi.fn() } : null,
    ),
    conflict: computed(() => null),
    backupOffer: computed(() => null),
    previewCollection: computed(() => preview),
    canUndo: computed(() => true),
    canRedo: computed(() => true),
    checking: computed(() => checking.value),
    applySeq: vi.fn((next: Seq, _kind: 'structure') => {
      seq.value = next
    }),
    applyFields: vi.fn((next: CollectionFields, _kind: 'field' | 'exposure') => {
      fields.value = next
    }),
    setPhotoMeta: vi.fn(),
    setOverride: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    retry: vi.fn(),
    publish: vi.fn(),
    confirmPublish: vi.fn(),
    unpublish: vi.fn(),
    remove: vi.fn(),
    dispose: vi.fn(),
  }
  return { desk: d as unknown as Desk, fake: d, seq, checking, exposureOpen, saveState, errorMessage }
}

/** a (full), b+c (pair), text frame. */
function sample(): Seq {
  let s = insertPhotos([], 0, [deskPhoto('a'), deskPhoto('b'), deskPhoto('c')])
  s = merge(s, 2, 1)
  s = insertText(s, 2)
  return setText(s, 2, '第一行')
}

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

function mountMobile(desk: Desk) {
  w = mount(DeskMobile, { props: { desk }, attachTo: document.body })
  return w
}

const rows = (wr: VueWrapper) => wr.findAll('[data-mobile-frame]')
const btn = (wr: VueWrapper, label: string) => wr.find(`button[aria-label="${label}"]`)
const ids = (s: Seq) => s.map((f) => f.photos.map((p) => p.id).join('+') || 'text')

describe('DeskMobile', () => {
  it('renders one row per frame with 第 N 帧, a thumbnail and labelled controls', () => {
    const { desk } = makeDesk(sample())
    const wr = mountMobile(desk)
    const r = rows(wr)
    expect(r).toHaveLength(3)
    expect(wr.find('ol').attributes('role')).toBe('list')
    expect(r.map((x) => x.attributes('role'))).toEqual(['listitem', 'listitem', 'listitem'])
    expect(r[0]!.text()).toContain('第 1 帧')
    expect(r[2]!.text()).toContain('第 3 帧')
    expect(r[0]!.find('.cover').exists()).toBe(true)
    for (const n of [1, 2, 3]) {
      for (const verb of ['上移', '下移', '删除']) {
        const b = btn(wr, `${verb}第 ${n} 帧`)
        expect(b.exists(), `${verb}第 ${n} 帧`).toBe(true)
        expect(b.text()).toBe(verb)
      }
    }
    // Visible labels tied to their controls.
    const sel = r[0]!.find('select')
    expect(wr.find(`label[for="${sel.attributes('id')}"]`).text()).toBe('版式')
    const title = r[0]!.find('input[data-photo-title]')
    expect(wr.find(`label[for="${title.attributes('id')}"]`).text()).toBe('照片标题')
    expect(wr.text()).toContain('在电脑上添加和编排照片')
    expect(wr.find('[aria-live="polite"]').exists()).toBe(true)
  })

  it('renders no archive, drag affordance or preview', () => {
    const { desk } = makeDesk(sample())
    const wr = mountMobile(desk)
    expect(wr.find('[draggable="true"]').exists()).toBe(false)
    expect(wr.text()).not.toContain('归档')
    expect(wr.text()).not.toContain('添加照片')
    expect(wr.find('[data-desk-archive]').exists()).toBe(false)
    expect(wr.find('.viewer').exists()).toBe(false)
    expect(wr.findComponent({ name: 'DeskArchive' }).exists()).toBe(false)
    expect(wr.findComponent({ name: 'DeskPreview' }).exists()).toBe(false)
  })

  it('上移 / 下移 call applySeq with move() and announce the new position', async () => {
    const { desk, fake } = makeDesk(sample())
    const wr = mountMobile(desk)
    const before = desk.seq.value
    await btn(wr, '下移第 1 帧').trigger('click')
    expect(fake.applySeq).toHaveBeenLastCalledWith(move(before, 0, 1), 'structure')
    expect(ids(desk.seq.value)).toEqual(['b+c', 'a', 'text'])
    await flushPromises()
    expect(wr.find('[aria-live="polite"]').text()).toBe('已移到第 2 帧')

    const mid = desk.seq.value
    await btn(wr, '上移第 3 帧').trigger('click')
    expect(fake.applySeq).toHaveBeenLastCalledWith(move(mid, 2, 1), 'structure')
    expect(ids(desk.seq.value)).toEqual(['b+c', 'text', 'a'])
    await flushPromises()
    expect(wr.find('[aria-live="polite"]').text()).toBe('已移到第 2 帧')
  })

  it('disables 上移 on the first frame and 下移 on the last', () => {
    const { desk } = makeDesk(sample())
    const wr = mountMobile(desk)
    expect(btn(wr, '上移第 1 帧').attributes('disabled')).toBeDefined()
    expect(btn(wr, '下移第 3 帧').attributes('disabled')).toBeDefined()
    expect(btn(wr, '下移第 1 帧').attributes('disabled')).toBeUndefined()
    expect(btn(wr, '上移第 3 帧').attributes('disabled')).toBeUndefined()
  })

  it('删除 calls applySeq with remove(), announces it and clamps the selection', async () => {
    const { desk, fake } = makeDesk(sample())
    desk.selected.value = 2
    const wr = mountMobile(desk)
    const before = desk.seq.value
    await btn(wr, '删除第 3 帧').trigger('click')
    expect(fake.applySeq).toHaveBeenLastCalledWith(remove(before, 2), 'structure')
    expect(rows(wr)).toHaveLength(2)
    expect(desk.selected.value).toBe(1)
    await flushPromises()
    expect(wr.find('[aria-live="polite"]').text()).toBe('已删除第 3 帧')
  })

  it('the layout select lists only allowed layouts and calls setLayout', async () => {
    const { desk, fake } = makeDesk(sample())
    const wr = mountMobile(desk)
    const r = rows(wr)
    const opts = (i: number) => r[i]!.findAll('select option').map((o) => [o.attributes('value'), o.text()])
    expect(opts(0)).toEqual([
      ['full', '满屏'],
      ['matted', '留白'],
    ])
    expect(opts(1)).toEqual([['pair', '并排']])
    expect(opts(2)).toEqual([['text', '文字页']])
    // A single option has nothing to switch to.
    expect(r[1]!.find('select').attributes('disabled')).toBeDefined()
    const before = desk.seq.value
    await r[0]!.find('select').setValue('matted')
    expect(fake.applySeq).toHaveBeenLastCalledWith(setLayout(before, 0, 'matted'), 'structure')
    expect(desk.seq.value[0]!.layout).toBe('matted')
  })

  it('edits the first photo title through setPhotoMeta, keeping the caption', async () => {
    const { desk, fake } = makeDesk(sample())
    const wr = mountMobile(desk)
    const r = rows(wr)
    const input = r[0]!.find<HTMLInputElement>('input[data-photo-title]')
    expect(input.element.value).toBe('浪')
    await input.setValue('浪花')
    expect(fake.setPhotoMeta).toHaveBeenLastCalledWith('a', { title: '浪花', caption: '傍晚' })
    // Pair: the first photo only. Text frame: no title field.
    expect(r[1]!.findAll('input[data-photo-title]')).toHaveLength(1)
    await r[1]!.find('input[data-photo-title]').setValue('新')
    expect(fake.setPhotoMeta).toHaveBeenLastCalledWith('b', { title: '新', caption: '图注b' })
    expect(r[2]!.find('input[data-photo-title]').exists()).toBe(false)
  })

  it('edits the collection title through applyFields', async () => {
    const { desk, fake } = makeDesk(sample())
    const wr = mountMobile(desk)
    const input = wr.find<HTMLInputElement>('input[data-collection-title]')
    expect(input.element.value).toBe('海边')
    expect(wr.find(`label[for="${input.attributes('id')}"]`).text()).toBe('合集标题')
    await input.setValue('海边日落')
    expect(fake.applyFields).toHaveBeenLastCalledWith({ ...FIELDS, title: '海边日落' }, 'field')
  })

  it('emits publish for a draft and unpublish for a published collection', async () => {
    const draft = makeDesk(sample())
    const wr = mountMobile(draft.desk)
    expect(wr.find('[data-mobile-publish]').text()).toBe('发布')
    await wr.find('[data-mobile-publish]').trigger('click')
    expect(wr.emitted('publish')).toHaveLength(1)
    expect(wr.emitted('unpublish')).toBeUndefined()
    wr.unmount()

    const pub = makeDesk(sample(), 'published')
    const wr2 = mountMobile(pub.desk)
    expect(wr2.find('[data-mobile-publish]').text()).toBe('撤回')
    await wr2.find('[data-mobile-publish]').trigger('click')
    expect(wr2.emitted('unpublish')).toHaveLength(1)
    expect(wr2.emitted('publish')).toBeUndefined()
  })

  it('shows the save state and a 重试 button on error', async () => {
    const { desk, fake, saveState, errorMessage } = makeDesk(sample())
    const wr = mountMobile(desk)
    expect(wr.find('[data-mobile-save]').text()).toBe('已保存')
    expect(wr.find('[data-mobile-save]').attributes('role')).toBe('status')
    saveState.value = 'saving'
    await flushPromises()
    expect(wr.find('[data-mobile-save]').text()).toBe('保存中…')
    saveState.value = 'error'
    errorMessage.value = '保存失败，请重试'
    await flushPromises()
    expect(wr.find('[data-mobile-save]').text()).toContain('未保存')
    expect(wr.find('[data-mobile-save]').text()).toContain('保存失败，请重试')
    const retry = wr.findAll('button').find((b) => b.text() === '重试')!
    await retry.trigger('click')
    expect(fake.retry).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['checking', (m: ReturnType<typeof makeDesk>) => (m.checking.value = true)],
    ['exposure dialog', (m: ReturnType<typeof makeDesk>) => (m.exposureOpen.value = true)],
  ])('disables structural controls while locked (%s)', async (_name, lock) => {
    const m = makeDesk(sample())
    const wr = mountMobile(m.desk)
    lock(m)
    await flushPromises()
    for (const n of [1, 2, 3]) {
      for (const verb of ['上移', '下移', '删除']) {
        expect(btn(wr, `${verb}第 ${n} 帧`).attributes('disabled'), `${verb}第 ${n} 帧`).toBeDefined()
      }
    }
    expect(rows(wr)[0]!.find('select').attributes('disabled')).toBeDefined()
    expect(wr.find('input[data-collection-title]').attributes('disabled')).toBeDefined()
    expect(wr.find('[data-mobile-publish]').attributes('disabled')).toBeDefined()
    // Even a forced click does nothing.
    ;(btn(wr, '删除第 1 帧').element as HTMLButtonElement).disabled = false
    await btn(wr, '删除第 1 帧').trigger('click')
    expect(m.fake.applySeq).not.toHaveBeenCalled()
  })

  it('owns no state: remounting on the same desk (a breakpoint switch) keeps the sequence', async () => {
    const m = makeDesk(sample())
    const wr = mountMobile(m.desk)
    await btn(wr, '下移第 1 帧').trigger('click')
    wr.unmount()
    const wr2 = mountMobile(m.desk)
    expect(rows(wr2).map((r) => r.attributes('aria-label'))).toEqual([
      '第 1 帧，并排，标题b、标题c',
      '第 2 帧，满屏，标题a',
      '第 3 帧，文字页，第一行',
    ])
  })
})
