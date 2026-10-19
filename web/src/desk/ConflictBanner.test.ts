import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ConflictBanner from './ConflictBanner.vue'

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
})

describe('ConflictBanner', () => {
  it('offers reload or overwrite on a conflict', async () => {
    w = mount(ConflictBanner, { props: { kind: 'conflict' } })
    const alert = w.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(w.find('dialog').exists()).toBe(false)
    expect(alert.find('p').text()).toBe('这个合集在别处被修改过')
    const [reload, overwrite] = w.findAll('button')
    expect([reload!.text(), overwrite!.text()]).toEqual(['载入最新版本', '用我的版本覆盖'])
    await reload!.trigger('click')
    await overwrite!.trigger('click')
    expect(w.emitted('reload')!.length).toBe(1)
    expect(w.emitted('overwrite')!.length).toBe(1)
  })

  it('offers restore or discard for a backup', async () => {
    w = mount(ConflictBanner, { props: { kind: 'backup' } })
    expect(w.find('[role="alert"] p').text()).toBe('有一份未保存的修改，要恢复吗？')
    const [restore, discard] = w.findAll('button')
    expect([restore!.text(), discard!.text()]).toEqual(['恢复', '丢弃'])
    await restore!.trigger('click')
    await discard!.trigger('click')
    expect(w.emitted('restore')!.length).toBe(1)
    expect(w.emitted('discard')!.length).toBe(1)
  })
})
