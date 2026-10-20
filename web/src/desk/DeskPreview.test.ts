import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import DeskPreview from './DeskPreview.vue'
import Viewer from '../viewer/Viewer.vue'
import { collection, fullFrame, photo, useTestRouter } from '../viewer/testFixtures'

useTestRouter()

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

describe('DeskPreview', () => {
  it('renders the Viewer in preview mode at 390×844, labelled 访客视角', () => {
    const c = collection([fullFrame(photo('p1')), fullFrame(photo('p2'))])
    w = mount(DeskPreview, { props: { collection: c, initialFrame: 2 }, attachTo: document.body })
    expect(w.find('h2').text()).toBe('访客视角')
    const v = w.findComponent(Viewer)
    expect(v.props('mode')).toBe('preview')
    expect(v.props('neighbors')).toBeNull()
    expect(v.props('initialFrame')).toBe(2)
    expect(v.props('collection')).toStrictEqual(c)
    const phone = w.find('.phone').attributes('style')
    expect(phone).toContain('width: 390px')
    expect(phone).toContain('height: 844px')
    expect(phone).toContain('scale(')
  })

  it('shows a note instead of the Viewer for an empty sequence', () => {
    w = mount(DeskPreview, { props: { collection: collection([]), initialFrame: 1 } })
    expect(w.findComponent(Viewer).exists()).toBe(false)
    expect(w.text()).toContain('序列为空')
  })

  it('keeps keys pressed outside the preview from driving the Viewer', async () => {
    const c = collection([fullFrame(photo('p1')), fullFrame(photo('p2'))])
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    w = mount(DeskPreview, { props: { collection: c, initialFrame: 1 }, attachTo: document.body })
    outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(w.findComponent(Viewer).emitted('frame')).toBeUndefined()
    // The same key inside the preview still reaches the Viewer.
    w.find('.stage').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(w.findComponent(Viewer).emitted('frame')).toEqual([[2]])
  })
})
