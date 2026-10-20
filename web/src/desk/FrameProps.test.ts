import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import FrameProps from './FrameProps.vue'
import { deskPhoto, fakeDesk } from './deskTestUtils'
import { insertPhotos, insertText, merge, setLayout, setText, type Seq } from './sequence'

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

function setup(seq: Seq, index = 0, locked = false) {
  const f = fakeDesk({ seq })
  w = mount(FrameProps, { props: { desk: f.desk, index, locked }, attachTo: document.body })
  return { w, ...f }
}
const radios = (wr: VueWrapper) => wr.findAll('input[type="radio"]')
const lastSeq = (m: { mock: { calls: unknown[][] } }) => m.mock.calls.at(-1)![0] as Seq

describe('FrameProps', () => {
  it('offers 版式 radios with only allowed layouts enabled', async () => {
    const { w, mocks } = setup(insertPhotos([], 0, [deskPhoto('a')]))
    expect(w.find('fieldset legend').text()).toBe('版式')
    expect(w.findAll('fieldset label').map((l) => l.text())).toEqual(['满屏', '留白', '并排', '文字页'])
    expect(radios(w).map((r) => (r.element as HTMLInputElement).disabled)).toEqual([false, false, true, true])
    expect((radios(w)[0]!.element as HTMLInputElement).checked).toBe(true)
    await radios(w)[1]!.setValue(true)
    expect(mocks.applySeq).toHaveBeenCalledTimes(1)
    expect(lastSeq(mocks.applySeq)[0]!.layout).toBe('matted')
    expect(mocks.applySeq.mock.calls[0]![1]).toBe('structure')
  })

  it('matted: a ratio range with a live output', async () => {
    const s = setLayout(insertPhotos([], 0, [deskPhoto('a')]), 0, 'matted')
    const { w, mocks } = setup(s)
    const r = w.find('input[type="range"]')
    expect(r.attributes()).toMatchObject({ min: '0.5', max: '0.95', step: '0.05' })
    expect(w.find('output').text()).toBe('0.80')
    // Dragging moves the output only; releasing commits one edit.
    ;(r.element as HTMLInputElement).value = '0.6'
    await r.trigger('input')
    expect(w.find('output').text()).toBe('0.60')
    expect(mocks.applySeq).not.toHaveBeenCalled()
    await r.trigger('change')
    expect(mocks.applySeq).toHaveBeenCalledTimes(1)
    expect(lastSeq(mocks.applySeq)[0]!.matteRatio).toBeCloseTo(0.6)
  })

  it('text: a textarea with a cleaned character counter', async () => {
    const s = setText(insertText([], 0), 0, '  你好 ')
    const { w, mocks } = setup(s)
    expect(w.text()).toContain('2 / 2000')
    await w.find('textarea').setValue('新的')
    await w.find('textarea').trigger('blur')
    expect(lastSeq(mocks.applySeq)[0]!.text).toBe('新的')
  })

  it('text: typing is one edit after an 800ms pause, not one per keystroke', async () => {
    vi.useFakeTimers()
    try {
      const { w, mocks } = setup(setText(insertText([], 0), 0, ''))
      const ta = w.find('textarea')
      for (const v of ['海', '海边', '海边的', '海边的风']) await ta.setValue(v)
      expect(mocks.applySeq).not.toHaveBeenCalled()
      expect(w.text()).toContain('4 / 2000')
      vi.advanceTimersByTime(799)
      expect(mocks.applySeq).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(mocks.applySeq).toHaveBeenCalledTimes(1)
      expect(lastSeq(mocks.applySeq)[0]!.text).toBe('海边的风')
      expect(mocks.applySeq.mock.calls[0]![1]).toBe('structure')
    } finally {
      vi.useRealTimers()
    }
  })

  it('text: unmounting commits what was typed; an unchanged text commits nothing', async () => {
    const { w, mocks } = setup(setText(insertText([], 0), 0, '原文'))
    await w.find('textarea').trigger('blur')
    expect(mocks.applySeq).not.toHaveBeenCalled()
    await w.find('textarea').setValue('改过')
    w.unmount()
    expect(mocks.applySeq).toHaveBeenCalledTimes(1)
    expect(lastSeq(mocks.applySeq)[0]!.text).toBe('改过')
  })

  it('text: stays editable while locked (text never widens exposure)', () => {
    const { w } = setup(setText(insertText([], 0), 0, ''), 0, true)
    expect((w.find('textarea').element as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('pair: 拆成单张 splits the frame', async () => {
    const s = merge(insertPhotos([], 0, [deskPhoto('a'), deskPhoto('b')]), 1, 0)
    const { w, mocks } = setup(s)
    await w.findAll('button').find((b) => b.text() === '拆成单张')!.trigger('click')
    expect(lastSeq(mocks.applySeq)).toHaveLength(2)
  })

  it('disables structural controls while locked', () => {
    const s = merge(insertPhotos([], 0, [deskPhoto('a'), deskPhoto('b')]), 1, 0)
    const { w } = setup(s, 0, true)
    expect(radios(w).every((r) => (r.element as HTMLInputElement).disabled)).toBe(true)
    expect((w.findAll('button').find((b) => b.text() === '拆成单张')!.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('text: a reload inside the idle window commits the draft and asks to stay', async () => {
    const { w, mocks } = setup(setText(insertText([], 0), 0, ''))
    await w.find('textarea').setValue('还没停')
    expect(mocks.applySeq).not.toHaveBeenCalled()
    const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(mocks.applySeq).toHaveBeenCalledTimes(1)
    expect(lastSeq(mocks.applySeq)[0]!.text).toBe('还没停')
    // Nothing pending: no prompt.
    const e2 = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    window.dispatchEvent(e2)
    expect(e2.defaultPrevented).toBe(false)
  })
})
