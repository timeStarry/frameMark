import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { usePageHeading } from './pageHeading'

const Page = defineComponent({
  props: { title: { type: String, required: true } },
  setup(props) {
    const heading = ref<HTMLElement | null>(null)
    usePageHeading(heading, () => props.title)
    return () => h('main', [h('h1', { ref: heading, tabindex: -1 }, props.title)])
  },
})

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  window.history.replaceState(null, '')
})

describe('usePageHeading', () => {
  it('sets the title, follows changes, and resets it on unmount', async () => {
    w = mount(Page, { props: { title: '登录' }, attachTo: document.body })
    expect(document.title).toBe('登录 — Markr')
    await w.setProps({ title: '注册' })
    expect(document.title).toBe('注册 — Markr')
    w.unmount()
    w = null
    expect(document.title).toBe('Markr')
  })

  it('focuses the h1 after an in-app navigation', async () => {
    window.history.replaceState({ back: '/' }, '')
    w = mount(Page, { props: { title: '偏好' }, attachTo: document.body })
    await new Promise((r) => setTimeout(r, 0))
    expect(document.activeElement).toBe(w.find('h1').element)
  })

  it('leaves focus alone on the first page of a visit', async () => {
    window.history.replaceState({ back: null }, '')
    w = mount(Page, { props: { title: '归档' }, attachTo: document.body })
    await new Promise((r) => setTimeout(r, 0))
    expect(document.activeElement).not.toBe(w.find('h1').element)
  })
})
