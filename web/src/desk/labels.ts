// labels.ts — the desk's visible and spoken names for frames (spec §5).
import type { FrameLayout } from '../api/types'
import type { DeskFrame } from './sequence'

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
