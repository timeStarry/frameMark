import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ConfirmDialog from './ConfirmDialog.vue'

let w: VueWrapper | null = null

afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

function make(props: Partial<{ open: boolean; error: string; busy: boolean }> = {}) {
  w = mount(ConfirmDialog, {
    props: { title: '删除这张照片？', body: '正文', confirmLabel: '删除', open: false, ...props },
    attachTo: document.body,
  })
  return w
}

describe('ConfirmDialog', () => {
  it('is closed until open, then shows title, body and focuses 取消', async () => {
    make()
    const d = w!.find('dialog')
    expect(d.attributes('open')).toBeUndefined()
    await w!.setProps({ open: true })
    await flushPromises()
    expect(d.attributes('open')).toBeDefined()
    expect(document.getElementById(d.attributes('aria-labelledby')!)!.textContent).toBe('删除这张照片？')
    expect(document.getElementById(d.attributes('aria-describedby')!)!.textContent).toBe('正文')
    expect((document.activeElement as HTMLElement).textContent).toBe('取消')
    expect(d.findAll('button').map((b) => b.text())).toEqual(['取消', '删除'])
  })

  it('emits confirm and cancel; Esc emits cancel', async () => {
    make({ open: true })
    await flushPromises()
    const [cancel, confirm] = w!.find('dialog').findAll('button')
    await confirm!.trigger('click')
    await cancel!.trigger('click')
    w!.find('dialog').element.dispatchEvent(new Event('cancel', { cancelable: true }))
    w!.find('dialog').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w!.emitted('confirm')!.length).toBe(1)
    expect(w!.emitted('cancel')!.length).toBe(3)
  })

  it('shows an error and disables confirm while busy', async () => {
    make({ open: true, error: '失败了', busy: true })
    await flushPromises()
    expect(w!.find('[role="alert"]').text()).toBe('失败了')
    const confirm = w!.find('dialog').findAll('button')[1]!
    expect(confirm.attributes('disabled')).toBeDefined()
    await confirm.trigger('click')
    expect(w!.emitted('confirm')).toBeUndefined()
  })

  it('closes when open turns false', async () => {
    make({ open: true })
    await flushPromises()
    await w!.setProps({ open: false })
    await flushPromises()
    expect(w!.find('dialog').attributes('open')).toBeUndefined()
  })
  it('emits cancel when the dialog closes natively while open is still set', async () => {
    make({ open: true })
    await flushPromises()
    // A close request the browser does not let cancel veto (e.g. a repeated
    // Android back gesture) closes the dialog without a cancel event.
    const d = w!.find('dialog').element as HTMLDialogElement
    d.removeAttribute('open')
    d.dispatchEvent(new Event('close'))
    expect(w!.emitted('cancel')!.length).toBe(1)
  })

  it('ignores a queued close that arrives after the dialog reopened', async () => {
    make({ open: true })
    await flushPromises()
    await w!.setProps({ open: false })
    await flushPromises()
    await w!.setProps({ open: true })
    await flushPromises()
    // The close task queued by the first close() runs only now.
    w!.find('dialog').element.dispatchEvent(new Event('close'))
    expect(w!.emitted('cancel')).toBeUndefined()
    expect(w!.find('dialog').attributes('open')).toBeDefined()
  })

  it('does not emit cancel for the close that follows open turning false', async () => {
    make({ open: true })
    await flushPromises()
    await w!.setProps({ open: false })
    w!.find('dialog').element.dispatchEvent(new Event('close'))
    await flushPromises()
    expect(w!.emitted('cancel')).toBeUndefined()
  })
})
