import { describe, expect, it } from 'vitest'
import { FIELD_LABEL, LICENSE_LABEL, SAVE_LABEL, joinLabels, manifestLines } from './labels'
import type { Manifest } from '../api/types'

const base: Manifest = {
  photos: 12,
  publicFields: [],
  histogram: false,
  originalDownload: false,
  visibility: 'private',
  inSquare: false,
}

describe('manifest labels', () => {
  it('keeps FIELD_LABEL in spec order', () => {
    expect(Object.keys(FIELD_LABEL)).toEqual([
      'camera', 'lens', 'focal_length', 'aperture', 'shutter', 'iso', 'exposure_bias', 'taken_date',
    ])
    expect(Object.values(FIELD_LABEL)).toEqual(['机身', '镜头', '焦段', '光圈', '快门', 'ISO', '曝光补偿', '拍摄日期'])
  })

  it('joins labels with 与 and 、', () => {
    expect(joinLabels([])).toBe('')
    expect(joinLabels(['a'])).toBe('a')
    expect(joinLabels(['a', 'b'])).toBe('a与b')
    expect(joinLabels(['a', 'b', 'c'])).toBe('a、b与c')
    expect(joinLabels(['a', 'b', 'c', 'd'])).toBe('a、b、c与d')
  })

  it('names every license', () => {
    expect(LICENSE_LABEL).toEqual({
      by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nd': 'CC BY-ND',
      'by-nc': 'CC BY-NC', 'by-nc-sa': 'CC BY-NC-SA', 'by-nc-nd': 'CC BY-NC-ND',
    })
  })

  it('lists a closed manifest', () => {
    expect(manifestLines(base, null, null)).toEqual([
      '12 张', '不公开拍摄参数', '不公开直方图', '原图下载关闭', '私密', '不进广场', '未设置许可', '未声明 AI 使用',
    ])
  })

  it('lists an open manifest with fields in FIELD_LABEL order', () => {
    const m: Manifest = {
      ...base,
      photos: 3,
      publicFields: ['iso', 'camera', 'aperture'],
      histogram: true,
      originalDownload: true,
      visibility: 'public',
      inSquare: true,
    }
    expect(manifestLines(m, 'by-nc', 'no-generative-ai')).toEqual([
      '3 张', '公开机身、光圈与ISO', '公开直方图', '原图下载开启', '公开', '进入广场', '许可 CC BY-NC', '未使用生成式 AI',
    ])
    expect(manifestLines({ ...base, visibility: 'unlisted' }, null, 'other')[4]).toBe('仅链接')
  })

  it('names every save state', () => {
    expect(SAVE_LABEL).toEqual({
      saved: '已保存', saving: '保存中…', unsaved: '未保存', error: '未保存 ·', conflict: '有冲突，未保存',
    })
  })
})
