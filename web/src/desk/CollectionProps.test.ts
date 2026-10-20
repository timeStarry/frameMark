import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CollectionProps from './CollectionProps.vue'
import { deskPhoto, fakeDesk } from './deskTestUtils'
import { insertPhotos } from './sequence'
import type { CollectionFields } from '../api/types'

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

function setup(fields: Partial<CollectionFields> = {}, locked = false) {
  const f = fakeDesk({ seq: insertPhotos([], 0, [deskPhoto('a'), deskPhoto('b')]), fields })
  w = mount(CollectionProps, { props: { desk: f.desk, locked }, attachTo: document.body })
  return { w, ...f }
}
const byLabel = (wr: VueWrapper, text: string) => {
  const l = wr.findAll('label').find((x) => x.text().startsWith(text))!
  const id = l.attributes('for')
  return id ? wr.find(`#${CSS.escape(id)}`) : l.find('input')
}
const lastFields = (m: { mock: { calls: unknown[][] } }) => m.mock.calls.at(-1) as [CollectionFields, string]

describe('CollectionProps', () => {
  it('edits title and intro as field edits', async () => {
    const { w, mocks } = setup()
    await byLabel(w, '标题').setValue('山')
    expect(lastFields(mocks.applyFields)).toEqual([expect.objectContaining({ title: '山' }), 'field'])
    await byLabel(w, '简介').setValue('一段')
    expect(lastFields(mocks.applyFields)).toEqual([expect.objectContaining({ intro: '一段', title: '海边' }), 'field'])
  })

  it('maps the cover select to coverPhotoId', async () => {
    const { w, mocks } = setup()
    const sel = byLabel(w, '封面')
    expect(sel.findAll('option').map((o) => o.text())).toEqual(['自动（第一张）', '标题a', '标题b'])
    await sel.setValue('b')
    expect(lastFields(mocks.applyFields)).toEqual([expect.objectContaining({ coverPhotoId: 'b' }), 'exposure'])
    await sel.setValue('')
    expect(lastFields(mocks.applyFields)[0].coverPhotoId).toBeNull()
  })

  it('visibility radios, the unlisted note and 进入广场 only when public', async () => {
    const { w, mocks, fields } = setup()
    expect((byLabel(w, '进入广场').element as HTMLInputElement).disabled).toBe(true)
    await byLabel(w, '仅链接').setValue(true)
    expect(lastFields(mocks.applyFields)).toEqual([expect.objectContaining({ visibility: 'unlisted' }), 'exposure'])
    fields.value = { ...fields.value, visibility: 'unlisted' }
    await flushPromises()
    expect(w.text()).toContain('知道链接的人都能看，并不是安全的访问控制')
    fields.value = { ...fields.value, visibility: 'public' }
    await flushPromises()
    const sq = byLabel(w, '进入广场')
    expect((sq.element as HTMLInputElement).disabled).toBe(false)
    await sq.setValue(true)
    expect(lastFields(mocks.applyFields)).toEqual([expect.objectContaining({ distribute: true }), 'exposure'])
  })

  it('license, AI declaration and original download', async () => {
    const { w, mocks } = setup()
    const lic = byLabel(w, '许可')
    expect(lic.findAll('option').map((o) => o.text())).toEqual(['无', 'CC BY', 'CC BY-SA', 'CC BY-ND', 'CC BY-NC', 'CC BY-NC-SA', 'CC BY-NC-ND'])
    await lic.setValue('by-nc-sa')
    expect(lastFields(mocks.applyFields)).toEqual([expect.objectContaining({ license: 'by-nc-sa' }), 'exposure'])
    await lic.setValue('')
    expect(lastFields(mocks.applyFields)[0].license).toBeNull()
    await byLabel(w, 'AI 声明').setValue('no-generative-ai')
    expect(lastFields(mocks.applyFields)[0].aiDeclaration).toBe('no-generative-ai')
    await byLabel(w, '允许下载原图').setValue(true)
    expect(lastFields(mocks.applyFields)).toEqual([expect.objectContaining({ originalDownload: true }), 'exposure'])
  })

  it('disables toggles and selects while locked', () => {
    const { w } = setup({ visibility: 'public' }, true)
    for (const t of ['封面', '私密', '仅链接', '公开', '进入广场', '许可', 'AI 声明', '允许下载原图'])
      expect((byLabel(w, t).element as HTMLInputElement).disabled, t).toBe(true)
  })

  it('deletes only after the title is typed', async () => {
    const { w, mocks } = setup({ title: ' 海边 ' })
    await w.findAll('button').find((b) => b.text() === '删除合集')!.trigger('click')
    await flushPromises()
    const dialog = w.find('dialog')
    const confirm = dialog.findAll('button').find((b) => b.text() === '删除')!
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true)
    await dialog.find('input').setValue('海')
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true)
    await dialog.find('input').setValue('海边')
    expect((confirm.element as HTMLButtonElement).disabled).toBe(false)
    await confirm.trigger('click')
    await flushPromises()
    expect(mocks.remove).toHaveBeenCalledTimes(1)
    expect(w.emitted('deleted')).toHaveLength(1)
  })

  it('an untitled collection needs 删除 typed; an empty box never confirms', async () => {
    const { w, mocks } = setup({ title: '' })
    await w.findAll('button').find((b) => b.text() === '删除合集')!.trigger('click')
    await flushPromises()
    const dialog = w.find('dialog')
    expect(dialog.text()).toContain('输入「删除」以确认')
    const confirm = dialog.findAll('button').find((b) => b.text() === '删除')!
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true)
    await confirm.trigger('click')
    await flushPromises()
    expect(mocks.remove).not.toHaveBeenCalled()
    await dialog.find('input').setValue('删除')
    expect((confirm.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the error when delete fails', async () => {
    const { w, mocks, errorMessage } = setup()
    mocks.remove.mockResolvedValue(false)
    errorMessage.value = '删除失败'
    await w.findAll('button').find((b) => b.text() === '删除合集')!.trigger('click')
    await flushPromises()
    await w.find('dialog input').setValue('海边')
    await w.find('dialog').findAll('button').find((b) => b.text() === '删除')!.trigger('click')
    await flushPromises()
    expect(w.emitted('deleted')).toBeUndefined()
    expect(w.find('[role="alert"]').text()).toBe('删除失败')
  })
})
