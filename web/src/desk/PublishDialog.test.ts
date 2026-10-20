import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import PublishDialog from './PublishDialog.vue'
import type { Manifest } from '../api/types'

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

const manifest: Manifest = {
  updatedAt: 1,
  photos: 2,
  publicFields: ['lens', 'camera'],
  histogram: true,
  originalDownload: false,
  visibility: 'unlisted',
  inSquare: false,
}

type P = { manifest: Manifest | null; license: string | null; aiDeclaration: string | null; message: string; stale: boolean; busy: boolean }
async function make(p: Partial<P> = {}) {
  w = mount(PublishDialog, {
    props: { manifest, license: 'by', aiDeclaration: 'no-generative-ai', message: '', stale: false, busy: false, ...p },
    attachTo: document.body,
  })
  await flushPromises()
  return w
}
const btn = (wr: VueWrapper, text: string) => wr.find('dialog').findAll('button').find((b) => b.text() === text)

describe('PublishDialog', () => {
  it('shows the manifest joined with 「 · 」 and focuses 取消', async () => {
    const wr = await make()
    const d = wr.find('dialog')
    expect(d.find('h2').text()).toBe('发布这组照片')
    expect(document.getElementById(d.attributes('aria-describedby')!)!.textContent).toBe(
      '2 张 · 公开机身与镜头 · 公开直方图 · 原图下载关闭 · 仅链接 · 不进广场 · 许可 CC BY · 未使用生成式 AI',
    )
    expect((document.activeElement as HTMLElement).textContent).toBe('取消')
    expect(wr.find('[role="alert"]').exists()).toBe(false)
    expect(btn(wr, '重新生成清单')).toBeUndefined()
  })

  it('emits confirm and cancel', async () => {
    const wr = await make()
    await btn(wr, '发布')!.trigger('click')
    await btn(wr, '取消')!.trigger('click')
    wr.find('dialog').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wr.emitted('confirm')!.length).toBe(1)
    expect(wr.emitted('cancel')!.length).toBe(2)
  })

  it('shows a refusal in an alert', async () => {
    const wr = await make({ message: '还没有设置封面' })
    expect(wr.find('[role="alert"]').text()).toBe('还没有设置封面')
    expect(btn(wr, '发布')!.attributes('disabled')).toBeUndefined()
  })

  it('offers 重新生成清单 and blocks 发布 when stale', async () => {
    const wr = await make({ message: '内容有变化，请重新确认发布清单', stale: true })
    expect(wr.find('[role="alert"]').text()).toBe('内容有变化，请重新确认发布清单')
    const pub = btn(wr, '发布')!
    expect(pub.attributes('disabled')).toBeDefined()
    await pub.trigger('click')
    expect(wr.emitted('confirm')).toBeUndefined()
    await btn(wr, '重新生成清单')!.trigger('click')
    expect(wr.emitted('regenerate')!.length).toBe(1)
  })

  it('disables 发布 while busy or without a manifest', async () => {
    const wr = await make({ busy: true })
    expect(btn(wr, '发布')!.attributes('disabled')).toBeDefined()
    await wr.setProps({ busy: false, manifest: null })
    expect(btn(wr, '发布')!.attributes('disabled')).toBeDefined()
    await btn(wr, '发布')!.trigger('click')
    expect(wr.emitted('confirm')).toBeUndefined()
  })
})
