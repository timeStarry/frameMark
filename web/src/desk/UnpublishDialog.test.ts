import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UnpublishDialog from './UnpublishDialog.vue'

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

describe('UnpublishDialog', () => {
  it('asks before withdrawing and emits confirm and cancel', async () => {
    w = mount(UnpublishDialog, { attachTo: document.body })
    await flushPromises()
    const d = w.find('dialog')
    expect(d.attributes('open')).toBeDefined()
    expect(d.find('h2').text()).toBe('撤回这组照片？')
    expect(document.getElementById(d.attributes('aria-describedby')!)!.textContent).toBe('撤回后访客将看不到这组照片，链接会失效')
    expect((document.activeElement as HTMLElement).textContent).toBe('取消')
    const [cancel, confirm] = d.findAll('button')
    expect(confirm!.text()).toBe('撤回')
    await confirm!.trigger('click')
    await cancel!.trigger('click')
    d.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('confirm')!.length).toBe(1)
    expect(w.emitted('cancel')!.length).toBe(2)
  })
})
