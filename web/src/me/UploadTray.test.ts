import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import UploadTray from './UploadTray.vue'
import { summarize, type QueueItem } from './uploadQueue'

let n = 0
function item(state: QueueItem['state'], over: Partial<QueueItem> = {}): QueueItem {
  return {
    key: `k${++n}`,
    file: new File(['x'], `f${n}.jpg`, { type: 'image/jpeg' }),
    state,
    progress: 0,
    message: '',
    photo: null,
    retryable: state === 'failed',
    settled: false,
    ...over,
  }
}

describe('summarize', () => {
  it('omits zero parts and is empty with no items', () => {
    expect(summarize([])).toBe('')
    expect(summarize([item('done'), item('duplicate'), item('done'), item('failed')])).toBe('3 张完成，1 张失败')
    expect(summarize([item('uploading'), item('queued')])).toBe('2 张进行中')
    expect(summarize([item('processing', { settled: true }), item('rejected'), item('hashing')])).toBe('1 张完成，1 张失败，1 张进行中')
  })
})

describe('UploadTray', () => {
  it('lists name, state label and a labelled progress per item, with a polite summary', async () => {
    const items = [item('uploading', { progress: 0.4 }), item('failed', { message: '上传失败，请重试' }), item('done')]
    const w = mount(UploadTray, { props: { items }, attachTo: document.body })
    const rows = w.findAll('li')
    expect(rows.length).toBe(3)
    expect(rows[0]!.text()).toContain(items[0]!.file.name)
    expect(rows[0]!.text()).toContain('上传中')
    expect(rows[1]!.text()).toContain('失败')
    expect(rows[1]!.text()).toContain('上传失败，请重试')
    expect(rows[2]!.text()).toContain('完成')
    const bar = rows[0]!.find('progress')
    expect((bar.element as HTMLProgressElement).value).toBe(0.4)
    const label = bar.attributes('aria-labelledby')!
    const name = label
      .split(' ')
      .map((id) => document.getElementById(id)!.textContent)
      .join(' ')
    expect(name).toContain(items[0]!.file.name)
    expect(w.find('[aria-live="polite"]').text()).toBe('1 张完成，1 张失败，1 张进行中')
    w.unmount()
  })

  it('shows 重试 only for retryable failures and emits retry/clear', async () => {
    const items = [item('failed'), item('failed', { retryable: false, message: '处理失败' }), item('rejected', { message: '文件超过 60 MB' }), item('done')]
    const w = mount(UploadTray, { props: { items } })
    const retries = w.findAll('button').filter((b) => b.text() === '重试')
    expect(retries.length).toBe(1)
    await retries[0]!.trigger('click')
    expect(w.emitted('retry')).toEqual([[items[0]!.key]])
    await w.findAll('button').find((b) => b.text() === '清除已完成')!.trigger('click')
    expect(w.emitted('clear')).toHaveLength(1)
  })

  it('hides 清除已完成 when nothing is finished', () => {
    const w = mount(UploadTray, { props: { items: [item('uploading'), item('failed')] } })
    expect(w.findAll('button').some((b) => b.text() === '清除已完成')).toBe(false)
  })

  it('renders nothing visible with no items, and an empty live region', () => {
    const w = mount(UploadTray, { props: { items: [] } })
    expect(w.find('ul').exists()).toBe(false)
    expect(w.find('[aria-live="polite"]').text()).toBe('')
  })
})
