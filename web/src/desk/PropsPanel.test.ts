import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import PropsPanel from './PropsPanel.vue'
import PhotoProps from './PhotoProps.vue'
import FrameProps from './FrameProps.vue'
import { deskPhoto, fakeDesk } from './deskTestUtils'
import { insertPhotos, merge } from './sequence'

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

const P = { title: '', caption: '', publicFields: [], histogramPublic: false, overridden: false }

function setup() {
  const s = merge(insertPhotos([], 0, [deskPhoto('a'), deskPhoto('b'), deskPhoto('c')]), 1, 0)
  const f = fakeDesk({ seq: s, photoProps: { a: P, b: P, c: P } })
  w = mount(PropsPanel, { props: { desk: f.desk, index: 0, locked: false }, attachTo: document.body })
  return w
}

describe('PropsPanel', () => {
  it('is an aside with 属性 and the photo, frame and collection sections', () => {
    const wr = setup()
    expect(wr.find('aside').exists()).toBe(true)
    expect(wr.find('h2').text()).toBe('属性')
    expect(wr.findAll('h3').map((h) => h.text())).toEqual(['照片', '帧'])
    expect(wr.findAllComponents(PhotoProps).map((c) => c.props('photoId'))).toEqual(['a', 'b'])
    expect(wr.findComponent(FrameProps).props('index')).toBe(0)
  })

  it('合集设置 emits openCollection and Esc emits close', async () => {
    const wr = setup()
    await wr.findAll('button').find((b) => b.text() === '合集设置')!.trigger('click')
    expect(wr.emitted('openCollection')).toHaveLength(1)
    await wr.find('aside').trigger('keydown', { key: 'Escape' })
    expect(wr.emitted('close')).toHaveLength(1)
  })
})
