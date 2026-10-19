// labels.ts — the desk's visible and spoken names for frames (spec §5).
import type { FrameLayout, Manifest, Visibility } from '../api/types'
import type { DeskFrame } from './sequence'
import type { SaveState } from './useDesk'

export const LAYOUT_LABEL: Readonly<Record<FrameLayout, string>> = {
  full: '满屏',
  matted: '留白',
  pair: '并排',
  text: '文字页',
}

const TEXT_TITLE_MAX = 30

/** The frame's title: its photo titles, or a text frame's first non-empty line. */
export function frameTitle(f: DeskFrame): string {
  if (f.layout === 'text') {
    const line = (f.text ?? '').split('\n').map((s) => s.trim()).find((s) => s !== '') ?? ''
    if (line === '') return '空文字页'
    const chars = [...line]
    return chars.length > TEXT_TITLE_MAX ? `${chars.slice(0, TEXT_TITLE_MAX).join('')}…` : line
  }
  const titles = f.photos.map((p) => p.title.trim() || '无标题')
  return titles.length > 0 ? titles.join('、') : '无标题'
}

/** 「第 N 帧，版式，标题」 (index is 0-based). */
export function frameLabel(f: DeskFrame, index: number): string {
  return `第 ${index + 1} 帧，${LAYOUT_LABEL[f.layout]}，${frameTitle(f)}`
}

/** The first two lines of a text frame, for its card. */
export function textPreview(f: DeskFrame): string {
  return (f.text ?? '').split('\n').slice(0, 2).join('\n')
}

// --- Publish manifest (spec §8) ---

/** Public EXIF fields, in the order the manifest names them. */
export const FIELD_LABEL: Readonly<Record<string, string>> = {
  camera: '机身',
  lens: '镜头',
  focal_length: '焦段',
  aperture: '光圈',
  shutter: '快门',
  iso: 'ISO',
  exposure_bias: '曝光补偿',
  taken_date: '拍摄日期',
}

export const LICENSE_LABEL: Readonly<Record<string, string>> = {
  by: 'CC BY',
  'by-sa': 'CC BY-SA',
  'by-nd': 'CC BY-ND',
  'by-nc': 'CC BY-NC',
  'by-nc-sa': 'CC BY-NC-SA',
  'by-nc-nd': 'CC BY-NC-ND',
}

const VISIBILITY_LABEL: Readonly<Record<Visibility, string>> = {
  private: '私密',
  unlisted: '仅链接',
  public: '公开',
}

/** 「a」, 「a与b」, 「a、b与c」. */
export function joinLabels(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? ''
  return `${list.slice(0, -1).join('、')}与${list[list.length - 1]}`
}

/** The publish manifest as short lines, in display order. */
export function manifestLines(m: Manifest, license: string | null, ai: string | null): string[] {
  const fields = Object.keys(FIELD_LABEL)
    .filter((k) => m.publicFields.includes(k))
    .map((k) => FIELD_LABEL[k]!)
  const licenseLabel = license ? LICENSE_LABEL[license] : undefined
  return [
    `${m.photos} 张`,
    fields.length > 0 ? `公开${joinLabels(fields)}` : '不公开拍摄参数',
    m.histogram ? '公开直方图' : '不公开直方图',
    m.originalDownload ? '原图下载开启' : '原图下载关闭',
    VISIBILITY_LABEL[m.visibility],
    m.inSquare ? '进入广场' : '不进广场',
    licenseLabel ? `许可 ${licenseLabel}` : '未设置许可',
    ai === 'no-generative-ai' ? '未使用生成式 AI' : '未声明 AI 使用',
  ]
}

// --- Top bar ---

export const SAVE_LABEL: Readonly<Record<SaveState, string>> = {
  saved: '已保存',
  saving: '保存中…',
  unsaved: '未保存',
  // The adjacent 重试 button completes 「未保存·重试」.
  error: '未保存 ·',
  conflict: '有冲突，未保存',
}
