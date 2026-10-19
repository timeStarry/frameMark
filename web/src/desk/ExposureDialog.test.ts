import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ExposureDialog from './ExposureDialog.vue'

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

const changes = [
  { kind: 'visibility', detail: '从私密改为公开' },
  { kind: 'fields', detail: '新增公开镜头' },
]

describe('ExposureDialog', () => {
  it('lists each change and focuses 撤销这次修改', async () => {
    w = mount(ExposureDialog, { props: { changes }, attachTo: document.body })
    await flushPromises()
    const d = w.find('dialog')
    expect(d.attributes('open')).toBeDefined()
    expect(d.find('h2').text()).toBe('这次修改会扩大公开范围')
    expect(d.findAll('li').map((li) => li.text())).toEqual(['从私密改为公开', '新增公开镜头'])
    expect((document.activeElement as HTMLElement).textContent).toBe('撤销这次修改')
    expect(d.findAll('button').map((b) => b.text())).toEqual(['撤销这次修改', '确认并保存'])
  })

  it('emits confirm, cancel, and cancel on Esc', async () => {
    w = mount(ExposureDialog, { props: { changes }, attachTo: document.body })
    await flushPromises()
    const [cancel, confirm] = w.find('dialog').findAll('button')
    await confirm!.trigger('click')
    await cancel!.trigger('click')
    w.find('dialog').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('confirm')!.length).toBe(1)
    expect(w.emitted('cancel')!.length).toBe(2)
  })
})
