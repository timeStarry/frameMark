import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { UploadPrefs, Watermark } from '../api/types'

const api = vi.hoisted(() => ({ getPrefs: vi.fn(), putPrefs: vi.fn() }))
vi.mock('../api/me', () => api)

import PrefsForm from './PrefsForm.vue'

function prefs(over: Partial<UploadPrefs> = {}): UploadPrefs {
  return {
    publicFields: ['camera', 'lens', 'aperture'],
    histogramPublic: true,
    originalDownload: false,
    watermark: null,
    defaultLicense: null,
    defaultAiDeclaration: null,
    locationMode: 'off',
    updatedAt: null,
    ...over,
  }
}

let w: VueWrapper | null = null

async function open(p: UploadPrefs = prefs()) {
  api.getPrefs.mockResolvedValue({ ok: true, data: p })
  w = mount(PrefsForm, { attachTo: document.body })
  await flushPromises()
  return w
}

const save = () => w!.findAll('button').find((b) => b.text() === '保存')!
const byLabel = (text: string) => {
  const label = w!.findAll('label').find((l) => l.text().startsWith(text))
  if (!label) throw new Error(`no label ${text}`)
  const id = label.attributes('for')
  return id ? w!.find(`#${CSS.escape(id)}`) : label.find('input')
}
const lastDirty = () => {
  const ev = w!.emitted('dirty') as boolean[][] | undefined
  return ev ? ev[ev.length - 1]![0] : undefined
}

beforeEach(() => {
  api.getPrefs.mockReset()
  api.putPrefs.mockReset()
})

afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
})

describe('PrefsForm', () => {
  it('renders a form with an h2, the lead line and the fields in order', async () => {
    await open()
    expect(w!.find('form h2').text()).toBe('上传偏好')
    expect(w!.text()).toContain('修改只影响之后上传的照片。已上传的照片在合集中逐张调整。')
    const fieldset = w!.findAll('fieldset').find((f) => f.find('legend').text() === '公开参数字段')!
    const boxes = fieldset.findAll('input[type="checkbox"]')
    expect(boxes.map((b) => b.attributes('value'))).toEqual([
      'camera',
      'lens',
      'focal_length',
      'aperture',
      'shutter',
      'iso',
      'exposure_bias',
      'taken_date',
    ])
    expect(fieldset.findAll('label').map((l) => l.text())).toEqual([
      '机身',
      '镜头',
      '焦段',
      '光圈',
      '快门',
      'ISO',
      '曝光补偿',
      '拍摄日期',
    ])
    expect(boxes.map((b) => (b.element as HTMLInputElement).checked)).toEqual([
      true,
      true,
      false,
      true,
      false,
      false,
      false,
      false,
    ])
    expect((byLabel('直方图默认公开').element as HTMLInputElement).checked).toBe(true)
    expect((byLabel('原图下载默认开启').element as HTMLInputElement).checked).toBe(false)
  })

  it('shows the location note and never offers a public location option', async () => {
    await open()
    expect(w!.text()).toContain('位置信息永远不会公开。')
    const loc = w!.findAll('fieldset').find((f) => f.find('legend').text() === '位置信息')!
    const radios = loc.findAll('input[type="radio"]')
    expect(radios.map((r) => r.attributes('value'))).toEqual(['off', 'archive'])
    expect(loc.findAll('label').map((l) => l.text())).toEqual(['不提取', '仅自己的归档可见'])
    expect(w!.html()).not.toMatch(/value="public"/)
    await radios[1]!.setValue(true)
    expect(w!.text()).toContain('位置信息永远不会公开。')
  })

  it('keeps 保存 disabled until something changes and tracks dirty against the baseline', async () => {
    await open()
    expect(save().attributes('disabled')).toBeDefined()
    expect(lastDirty()).toBe(false)
    const iso = w!.find('input[value="iso"]')
    await iso.setValue(true)
    expect(save().attributes('disabled')).toBeUndefined()
    expect(lastDirty()).toBe(true)
    await iso.setValue(false)
    expect(save().attributes('disabled')).toBeDefined()
    expect(lastDirty()).toBe(false)
  })

  it('saves the exact payload and replaces the baseline with the response', async () => {
    await open()
    await w!.find('input[value="iso"]').setValue(true)
    await w!.find('input[value="camera"]').setValue(false)
    await byLabel('原图下载默认开启').setValue(true)
    await byLabel('默认许可').setValue('by-nc')
    await w!.find('input[name$="ai"][value="no-generative-ai"]').setValue(true)
    await w!.find('input[value="archive"]').setValue(true)
    const saved = prefs({
      publicFields: ['lens', 'aperture', 'iso'],
      originalDownload: true,
      defaultLicense: 'by-nc',
      defaultAiDeclaration: 'no-generative-ai',
      locationMode: 'archive',
      updatedAt: 99,
    })
    api.putPrefs.mockResolvedValue({ ok: true, status: 200, data: saved })
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(api.putPrefs).toHaveBeenCalledTimes(1)
    expect(api.putPrefs.mock.calls[0]![0]).toStrictEqual({
      publicFields: ['lens', 'aperture', 'iso'],
      histogramPublic: true,
      originalDownload: true,
      watermark: null,
      defaultLicense: 'by-nc',
      defaultAiDeclaration: 'no-generative-ai',
      locationMode: 'archive',
    })
    expect(w!.find('[role="status"]').text()).toBe('已保存')
    expect(save().attributes('disabled')).toBeDefined()
    expect(lastDirty()).toBe(false)
    // A later change clears 已保存.
    await w!.find('input[value="shutter"]').setValue(true)
    expect(w!.find('[role="status"]').text()).toBe('')
  })

  it('sends a watermark object with 文字 and null with 关闭', async () => {
    await open()
    expect(w!.find('input[type="range"]').exists()).toBe(false)
    await w!.find('input[name$="wm"][value="text"]').setValue(true)
    await byLabel('水印文字').setValue('© 阿树')
    await byLabel('位置').setValue('tl')
    const opacity = byLabel('不透明度')
    expect(opacity.attributes()).toMatchObject({ min: '0.1', max: '0.8', step: '0.05' })
    await opacity.setValue('0.3')
    const size = byLabel('大小')
    expect(size.attributes()).toMatchObject({ min: '0.02', max: '0.08', step: '0.005' })
    await size.setValue('0.06')
    const outputs = w!.findAll('output')
    expect(outputs.map((o) => o.text())).toEqual(['30%', '6.0%'])
    expect(opacity.attributes('aria-valuetext')).toBe('30%')
    const wm: Watermark = { text: '© 阿树', position: 'tl', opacity: 0.3, scale: 0.06 }
    api.putPrefs.mockResolvedValue({ ok: true, status: 200, data: prefs({ watermark: wm, updatedAt: 1 }) })
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(api.putPrefs.mock.calls[0]![0].watermark).toStrictEqual(wm)

    await w!.find('input[name$="wm"][value="off"]').setValue(true)
    api.putPrefs.mockResolvedValue({ ok: true, status: 200, data: prefs({ updatedAt: 2 }) })
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(api.putPrefs.mock.calls[1]![0].watermark).toBeNull()
  })

  it('loads an existing watermark into the 文字 controls', async () => {
    await open(prefs({ watermark: { text: 'markr', position: 'center', opacity: 0.5, scale: 0.04 } }))
    expect((w!.find('input[name$="wm"][value="text"]').element as HTMLInputElement).checked).toBe(true)
    expect((byLabel('水印文字').element as HTMLInputElement).value).toBe('markr')
    expect((byLabel('位置').element as HTMLSelectElement).value).toBe('center')
    expect(save().attributes('disabled')).toBeDefined()
  })

  it('rejects empty or over-long watermark text without calling the server', async () => {
    await open()
    await w!.find('input[name$="wm"][value="text"]').setValue(true)
    await byLabel('水印文字').setValue('   ')
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(api.putPrefs).not.toHaveBeenCalled()
    expect(w!.find('[role="alert"]').text()).toBe('水印文字需为 1–64 个字符。')
    await byLabel('水印文字').setValue('字'.repeat(65))
    await w!.find('form').trigger('submit')
    expect(api.putPrefs).not.toHaveBeenCalled()
    await byLabel('水印文字').setValue('字'.repeat(64))
    api.putPrefs.mockResolvedValue({ ok: true, status: 200, data: prefs() })
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(api.putPrefs).toHaveBeenCalledTimes(1)
  })

  it('shows the server message on failure and stays dirty', async () => {
    await open()
    await w!.find('input[value="iso"]').setValue(true)
    api.putPrefs.mockResolvedValue({ ok: false, status: 400, message: '水印设置无效。' })
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(w!.find('[role="alert"]').text()).toBe('水印设置无效。')
    expect(save().attributes('disabled')).toBeUndefined()
    expect(lastDirty()).toBe(true)
  })

  it('shows a retry when loading fails', async () => {
    api.getPrefs.mockResolvedValueOnce({ ok: false, status: 0 })
    w = mount(PrefsForm, { attachTo: document.body })
    await flushPromises()
    expect(w.text()).toContain('网络连接出了问题')
    api.getPrefs.mockResolvedValueOnce({ ok: true, data: prefs() })
    await w.findAll('button').find((b) => b.text() === '重试')!.trigger('click')
    await flushPromises()
    expect(w.find('input[value="camera"]').exists()).toBe(true)
  })
})
