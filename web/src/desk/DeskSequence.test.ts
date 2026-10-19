import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import DeskSequence from './DeskSequence.vue'
import { PHOTO_TYPE, FRAME_TYPE, writePhotos } from './dnd'
import { DTStub, deskPhoto, drag } from './deskTestUtils'
import { insertPhotos, insertText, setLayout, setText, type Seq } from './sequence'
import { useTestRouter } from '../viewer/testFixtures'

useTestRouter()

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

function seqOf(...ids: string[]): Seq {
  return insertPhotos([], 0, ids.map((id) => deskPhoto(id)))
}

function mountSeq(seq: Seq, selected = 0, locked = false) {
  w = mount(DeskSequence, { props: { seq, selected, locked }, attachTo: document.body })
  return w
}

const items = (wr: VueWrapper) => wr.findAll('[role="listitem"]')
type Edit = [Seq, string, boolean | undefined]
const edits = (wr: VueWrapper) => (wr.emitted('edit') ?? []) as Edit[]
const ids = (s: Seq) => s.map((f) => f.photos.map((p) => p.id).join('+') || `text`)

describe('DeskSequence', () => {
  it('is a list of focusable frames labelled 第 N 帧，版式，标题', () => {
    let s = seqOf('a', 'b', 'c')
    s = setLayout(s, 1, 'matted')
    s = insertText(s, 3)
    s = setText(s, 3, '第一行\n第二行')
    s = insertPhotos(s, 4, [deskPhoto('d')])
    const wr = mountSeq(s)
    expect(wr.find('ol').attributes('role')).toBe('list')
    const it = items(wr)
    expect(it).toHaveLength(5)
    expect(it.map((i) => i.attributes('tabindex'))).toEqual(['0', '0', '0', '0', '0'])
    expect(it.map((i) => i.attributes('aria-label'))).toEqual([
      '第 1 帧，满屏，标题a',
      '第 2 帧，留白，标题b',
      '第 3 帧，满屏，标题c',
      '第 4 帧，文字页，第一行',
      '第 5 帧，满屏，标题d',
    ])
    // Text frames show their first two lines.
    expect(it[3]!.text()).toContain('第一行\n第二行')
    expect(wr.text()).toContain('⌥↑ ⌥↓ 移动')
  })

  it('labels a pair 并排 with both titles', async () => {
    const wr = mountSeq(seqOf('a', 'b'))
    const t = wr.find('[data-frame-key]').element
    // Drag frame 2 onto frame 1 to merge, then remount with the result.
    const dt = new DTStub()
    drag(items(wr)[1]!.element, 'dragstart', dt)
    expect(dt.types).toEqual([FRAME_TYPE])
    drag(t, 'drop', dt)
    const [next, msg] = edits(wr)[0]!
    expect(msg).toBe('已合成并排：第 1 帧')
    w!.unmount()
    const wr2 = mountSeq(next)
    expect(items(wr2).map((i) => i.attributes('aria-label'))).toEqual(['第 1 帧，并排，标题a、标题b'])
    expect(items(wr2)[0]!.findAll('.thumb')).toHaveLength(2)
  })

  it('⌥↓ / ⌥↑ move the focused frame and announce the new position', async () => {
    const wr = mountSeq(seqOf('a', 'b', 'c'))
    await items(wr)[0]!.trigger('keydown', { key: 'ArrowDown', altKey: true })
    expect(ids(edits(wr)[0]![0])).toEqual(['b', 'a', 'c'])
    expect(edits(wr)[0]![1]).toBe('已移到第 2 帧')
    await items(wr)[2]!.trigger('keydown', { key: 'ArrowUp', altKey: true })
    expect(ids(edits(wr)[1]![0])).toEqual(['a', 'c', 'b'])
    expect(edits(wr)[1]![1]).toBe('已移到第 2 帧')
    // At the edges nothing moves.
    await items(wr)[0]!.trigger('keydown', { key: 'ArrowUp', altKey: true })
    expect(edits(wr)).toHaveLength(2)
  })

  it('keeps focus on the moved frame after the parent applies the edit', async () => {
    const wr = mountSeq(seqOf('a', 'b', 'c'))
    const key = items(wr)[0]!.attributes('data-frame-key')
    ;(items(wr)[0]!.element as HTMLElement).focus()
    await items(wr)[0]!.trigger('keydown', { key: 'ArrowDown', altKey: true })
    await wr.setProps({ seq: edits(wr)[0]![0] })
    await nextTick()
    expect((document.activeElement as HTMLElement).dataset.frameKey).toBe(key)
    expect(items(wr)[1]!.attributes('data-frame-key')).toBe(key)
  })

  it('Delete and Backspace remove the frame, flagged for the undo toast', async () => {
    const wr = mountSeq(seqOf('a', 'b', 'c'))
    await items(wr)[1]!.trigger('keydown', { key: 'Delete' })
    expect(ids(edits(wr)[0]![0])).toEqual(['a', 'c'])
    expect(edits(wr)[0]![1]).toBe('已删除第 2 帧')
    expect(edits(wr)[0]![2]).toBe(true)
    await items(wr)[0]!.trigger('keydown', { key: 'Backspace' })
    expect(ids(edits(wr)[1]![0])).toEqual(['b', 'c'])
  })

  it('Enter selects; ↑/↓ move focus between frames', async () => {
    const wr = mountSeq(seqOf('a', 'b'))
    await items(wr)[1]!.trigger('keydown', { key: 'Enter' })
    expect(wr.emitted('select')).toEqual([[1]])
    ;(items(wr)[0]!.element as HTMLElement).focus()
    await items(wr)[0]!.trigger('keydown', { key: 'ArrowDown' })
    await nextTick()
    expect(document.activeElement).toBe(items(wr)[1]!.element)
    expect(wr.emitted('focus')!.at(-1)).toEqual([1])
  })

  it('drops archive photos between frames (insert)', () => {
    const wr = mountSeq(seqOf('a', 'b'))
    const dt = new DTStub()
    writePhotos(dt as unknown as DataTransfer, [deskPhoto('x'), deskPhoto('y')])
    const gap = wr.find('[data-gap="1"]').element
    const over = drag(gap, 'dragover', dt)
    expect(over.defaultPrevented).toBe(true)
    expect(dt.dropEffect).toBe('copy')
    const drop = drag(gap, 'drop', dt)
    expect(drop.defaultPrevented).toBe(true)
    expect(ids(edits(wr)[0]![0])).toEqual(['a', 'x', 'y', 'b'])
    expect(edits(wr)[0]![1]).toBe('已加入 2 帧，从第 2 帧起')
    // The last gap appends.
    drag(wr.find('[data-gap="2"]').element, 'drop', dt)
    expect(ids(edits(wr)[1]![0])).toEqual(['a', 'b', 'x', 'y'])
  })

  it('drops into an empty sequence', () => {
    const wr = mountSeq([])
    expect(wr.text()).toContain('从左侧归档拖入照片，或按 Enter 加入')
    const dt = new DTStub()
    writePhotos(dt as unknown as DataTransfer, [deskPhoto('x')])
    drag(wr.find('[data-gap="0"]').element, 'drop', dt)
    expect(ids(edits(wr)[0]![0])).toEqual(['x'])
  })

  it('drops an archive photo on a full frame to merge it into a pair', async () => {
    const wr = mountSeq(seqOf('a', 'b'))
    const dt = new DTStub()
    writePhotos(dt as unknown as DataTransfer, [deskPhoto('x')])
    const target = items(wr)[1]!.element
    const over = drag(target, 'dragover', dt)
    expect(over.defaultPrevented).toBe(true)
    await nextTick()
    expect(wr.find('.hint').text()).toBe('合成并排')
    drag(target, 'drop', dt)
    const [next, msg] = edits(wr)[0]!
    expect(ids(next)).toEqual(['a', 'b+x'])
    expect(next[1]!.layout).toBe('pair')
    expect(msg).toBe('已合成并排：第 2 帧')
  })

  it('refuses to merge into a text frame or with several photos', () => {
    let s = insertText(seqOf('a'), 1)
    s = setText(s, 1, '字')
    const wr = mountSeq(s)
    const dt = new DTStub()
    writePhotos(dt as unknown as DataTransfer, [deskPhoto('x')])
    expect(drag(items(wr)[1]!.element, 'dragover', dt).defaultPrevented).toBe(false)
    const many = new DTStub()
    writePhotos(many as unknown as DataTransfer, [deskPhoto('x'), deskPhoto('y')])
    drag(items(wr)[0]!.element, 'drop', many)
    expect(edits(wr)).toHaveLength(0)
    expect(wr.emitted('refuse')).toEqual([['一次只能把一张照片合成并排']])
  })

  it('drags a frame to a gap to move it', () => {
    const wr = mountSeq(seqOf('a', 'b', 'c'))
    const dt = new DTStub()
    drag(items(wr)[0]!.element, 'dragstart', dt)
    expect(drag(wr.find('[data-gap="3"]').element, 'dragover', dt).defaultPrevented).toBe(true)
    expect(dt.dropEffect).toBe('move')
    drag(wr.find('[data-gap="3"]').element, 'drop', dt)
    expect(ids(edits(wr)[0]![0])).toEqual(['b', 'c', 'a'])
    expect(edits(wr)[0]![1]).toBe('已移到第 3 帧')
  })

  it('ignores drags without a desk payload', () => {
    const wr = mountSeq(seqOf('a'))
    const dt = new DTStub()
    dt.setData('text/plain', 'hi')
    expect(drag(wr.find('[data-gap="0"]').element, 'dragover', dt).defaultPrevented).toBe(false)
    drag(wr.find('[data-gap="0"]').element, 'drop', dt)
    expect(edits(wr)).toHaveLength(0)
    expect(PHOTO_TYPE).toBe('application/x-markr-photo')
  })

  it('the ＋ menu inserts a text frame or asks for the archive', async () => {
    const wr = mountSeq(seqOf('a', 'b'))
    const plus = wr.find('[data-gap="1"] .plus')
    expect(plus.attributes('aria-label')).toBe('在第 2 帧前插入')
    await plus.trigger('click')
    expect(plus.attributes('aria-expanded')).toBe('true')
    const buttons = wr.findAll('[data-gap="1"] .menu button')
    expect(buttons.map((b) => b.text())).toEqual(['文字页', '从归档添加'])
    expect(document.activeElement).toBe(buttons[0]!.element)
    await buttons[0]!.trigger('click')
    const [next, msg] = edits(wr)[0]!
    expect(next.map((f) => f.layout)).toEqual(['full', 'text', 'full'])
    expect(msg).toBe('已插入文字页，第 2 帧')
    await wr.find('[data-gap="2"] .plus').trigger('click')
    await wr.findAll('[data-gap="2"] .menu button')[1]!.trigger('click')
    expect(wr.emitted('fromArchive')).toHaveLength(1)
  })

  it('a drag started on a thumbnail image drags the whole frame', () => {
    const wr = mountSeq(seqOf('a', 'b'))
    const img = items(wr)[0]!.find('img')
    expect(img.exists()).toBe(true)
    // A browser pre-fills an image drag with its URL before dragstart runs.
    const dt = new DTStub()
    dt.setData('text/uri-list', '/m/a/w480.jpg')
    drag(img.element, 'dragstart', dt)
    expect(dt.types).toEqual([FRAME_TYPE])
    expect(dt.getData('text/uri-list')).toBe('')
    // The frame payload moves it like a drag from the card itself.
    drag(wr.find('[data-gap="2"]').element, 'drop', dt)
    expect(ids(edits(wr)[0]![0])).toEqual(['b', 'a'])
  })

  it('⌥M merges the next frame into the focused one', async () => {
    const wr = mountSeq(seqOf('a', 'b', 'c'))
    const key = items(wr)[1]!.attributes('data-frame-key')
    ;(items(wr)[1]!.element as HTMLElement).focus()
    // macOS reports ⌥M as key 'µ'; the physical code is what counts.
    await items(wr)[1]!.trigger('keydown', { key: 'µ', code: 'KeyM', altKey: true })
    const [next, msg] = edits(wr)[0]!
    expect(ids(next)).toEqual(['a', 'b+c'])
    expect(next[1]!.layout).toBe('pair')
    expect(next[1]!.key).toBe(key)
    expect(msg).toBe('已合成并排：第 2 帧')
    await wr.setProps({ seq: next })
    await nextTick()
    expect((document.activeElement as HTMLElement).dataset.frameKey).toBe(key)
    // A pair of 2 takes one more photo.
    await items(wr)[0]!.trigger('keydown', { key: 'm', code: 'KeyM', altKey: true })
    expect(edits(wr)).toHaveLength(1)
    expect(wr.emitted('refuse')!.at(-1)).toEqual(['下一帧不是单张照片，不能合成并排'])
  })

  it('⌥M refuses with a reason and changes nothing when the merge is not allowed', async () => {
    let s = insertText(seqOf('a', 'b'), 1)
    s = setText(s, 1, '字')
    s = insertPhotos(s, 3, [deskPhoto('b')])
    // a, text, b, b
    const wr = mountSeq(s)
    const press = (i: number) => items(wr)[i]!.trigger('keydown', { key: 'm', code: 'KeyM', altKey: true })
    await press(0)
    await press(1)
    await press(2)
    await press(3)
    expect(edits(wr)).toHaveLength(0)
    expect(wr.emitted('refuse')).toEqual([
      ['下一帧不是单张照片，不能合成并排'],
      ['这一帧不能合成并排'],
      ['两帧是同一张照片，不能合成并排'],
      ['后面没有可合成的帧'],
    ])
  })

  it('⌥M does nothing while locked', async () => {
    const wr = mountSeq(seqOf('a', 'b'), 0, true)
    await items(wr)[0]!.trigger('keydown', { key: 'm', code: 'KeyM', altKey: true })
    expect(edits(wr)).toHaveLength(0)
    expect(wr.emitted('refuse')).toBeUndefined()
  })

  it('lists ⌥M in the shortcut legend', () => {
    const wr = mountSeq(seqOf('a'))
    expect(wr.find('.legend').text()).toContain('⌥M 与下一帧合成并排')
  })
})
