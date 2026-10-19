import { afterEach, describe, expect, it } from 'vitest'
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
    await r.setValue('0.6')
    expect(lastSeq(mocks.applySeq)[0]!.matteRatio).toBeCloseTo(0.6)
  })

  it('text: a textarea with a cleaned character counter', async () => {
    const s = setText(insertText([], 0), 0, '  你好 ')
    const { w, mocks } = setup(s)
    expect(w.text()).toContain('2 / 2000')
    await w.find('textarea').setValue('新的')
    expect(lastSeq(mocks.applySeq)[0]!.text).toBe('新的')
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
})
