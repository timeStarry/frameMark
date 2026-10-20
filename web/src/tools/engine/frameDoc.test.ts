import { describe, expect, it } from 'vitest'
import { applyPreset, captionText, cleanText, defaultsFrame, FRAME_PRESETS } from './frameDoc'

describe('defaultsFrame', () => {
  it('starts with no asset, a light solid frame and no shooting fields', () => {
    const d = defaultsFrame()
    expect(d.kind).toBe('frame')
    expect(d.assetId).toBeNull()
    expect(d.frame).toBe('solid')
    expect(d.border).toBe(6)
    expect(d.fields).toEqual([])
    expect(d.format).toBe('image/jpeg')
    expect(d.longEdge).toBe(0)
  })

  it('returns a fresh object each time', () => {
    const a = defaultsFrame()
    a.fields.push('ISO')
    expect(defaultsFrame().fields).toEqual([])
  })
})

describe('presets', () => {
  it('has the four legacy presets', () => {
    expect(Object.keys(FRAME_PRESETS)).toEqual(['light', 'dark', 'soft', 'caption'])
  })

  it('applies a preset without touching caption text or output settings', () => {
    const d = { ...defaultsFrame(), text: 'hello', format: 'image/png' as const }
    const dark = applyPreset(d, 'dark')
    expect(dark.color).toBe('#16191b')
    expect(dark.textColor).toBe('#eeeeea')
    expect(dark.text).toBe('hello')
    expect(dark.format).toBe('image/png')
    expect(applyPreset(d, 'caption').frame).toBe('bottom-bar')
    expect(applyPreset(d, 'soft').frame).toBe('blur')
  })
})

describe('cleanText', () => {
  it('drops control and bidi characters but keeps newlines', () => {
    expect(cleanText('a\u0000b\u0007c‮d⁦e‏f؜g')).toBe('abcdefg')
    expect(cleanText('one\r\ntwo\rthree\nfour')).toBe('one\ntwo\nthree\nfour')
    expect(cleanText('a\tb')).toBe('ab')
  })

  it('caps the caption at 200 code points', () => {
    expect(Array.from(cleanText('😀'.repeat(250)))).toHaveLength(200)
  })
})

describe('captionText', () => {
  it('appends the ticked shooting fields, preferring hand-edited values', () => {
    const d = { ...defaultsFrame(), text: 'Title', fields: ['Model', 'ISO', 'FNumber'], fieldValues: { ISO: '200' } }
    expect(captionText(d, { Model: 'X-T5', ISO: '100' })).toBe('Title\nX-T5 · 200')
  })

  it('draws no field unless ticked', () => {
    expect(captionText(defaultsFrame(), { Model: 'X-T5' })).toBe('')
  })
})
