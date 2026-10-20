import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import PhotoProps from './PhotoProps.vue'
import { fakeDesk } from './deskTestUtils'

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

const P = (over = {}) => ({ title: '浪', caption: '远处', publicFields: ['iso', 'camera'], histogramPublic: false, overridden: false, ...over })

function setup(locked = false, over = {}) {
  const f = fakeDesk({ photoProps: { p1: P(over) } })
  w = mount(PhotoProps, { props: { desk: f.desk, photoId: 'p1', locked }, attachTo: document.body })
  return { w, ...f }
}

const boxes = (wr: VueWrapper) => wr.findAll('input[type="checkbox"]')

describe('PhotoProps', () => {
  it('edits title and caption, keeping the other field', async () => {
    const { w, mocks } = setup()
    const title = w.find('input[type="text"]')
    expect((title.element as HTMLInputElement).value).toBe('浪')
    await title.setValue('海')
    expect(mocks.setPhotoMeta).toHaveBeenLastCalledWith('p1', { title: '海', caption: '远处' })
    await w.find('textarea').setValue('近处')
    expect(mocks.setPhotoMeta).toHaveBeenLastCalledWith('p1', { title: '浪', caption: '近处' })
  })

  it('shows eight fields in order plus 直方图公开 and sets the override', async () => {
    const { w, mocks } = setup()
    const labels = w.findAll('label').map((l) => l.text())
    for (const t of ['机身', '镜头', '焦段', '光圈', '快门', 'ISO', '曝光补偿', '拍摄日期', '直方图公开']) expect(labels).toContain(t)
    const b = boxes(w)
    expect(b).toHaveLength(9)
    expect(b.map((x) => (x.element as HTMLInputElement).checked)).toEqual([true, false, false, false, false, true, false, false, false])
    await b[1]!.setValue(true)
    expect(mocks.setOverride).toHaveBeenLastCalledWith('p1', { publicFields: ['camera', 'lens', 'iso'], histogramPublic: false })
    await b[8]!.setValue(true)
    expect(mocks.setOverride).toHaveBeenLastCalledWith('p1', { publicFields: ['camera', 'iso'], histogramPublic: true })
  })

  it('shows 恢复默认 only when overridden', async () => {
    const { w, mocks, photoProps } = setup()
    expect(w.findAll('button').some((b) => b.text() === '恢复默认')).toBe(false)
    photoProps.value = { p1: P({ overridden: true }) }
    await nextTick()
    const btn = w.findAll('button').find((b) => b.text() === '恢复默认')!
    await btn.trigger('click')
    expect(mocks.clearOverride).toHaveBeenCalledWith('p1')
  })

  it('locks the checkboxes and 恢复默认 but not the text inputs', () => {
    const { w } = setup(true, { overridden: true })
    expect(boxes(w).every((b) => (b.element as HTMLInputElement).disabled)).toBe(true)
    expect((w.findAll('button').find((b) => b.text() === '恢复默认')!.element as HTMLButtonElement).disabled).toBe(true)
    expect((w.find('input[type="text"]').element as HTMLInputElement).disabled).toBe(false)
    expect((w.find('textarea').element as HTMLTextAreaElement).disabled).toBe(false)
    expect(w.text()).toContain('正在确认公开范围…')
  })
})
