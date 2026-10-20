import type { FrameKind } from './geometry'

export type OutputFormat = 'image/jpeg' | 'image/png' | 'image/webp'
export type CaptionFont = 'sans-serif' | 'serif' | 'monospace'

export interface FrameDoc {
  kind: 'frame'
  assetId: string | null
  frame: FrameKind
  /** Frame width, % of the photo's short edge (0–20). */
  border: number
  /** Bottom bar height for the 'bottom-bar' frame, % of the short edge. */
  bottom: number
  /** Photo corner radius, % of the short edge (0–10). */
  radius: number
  /** Blur radius for the 'blur' frame, % of the short edge. */
  blur: number
  /** Caption, ≤ 200 code points after cleanText. */
  text: string
  font: CaptionFont
  /** Caption size, % of the short edge (0.5–8). */
  size: number
  opacity: number
  textColor: string
  color: string
  secondColor: string
  /** 3×3 grid, 0 = top left … 8 = bottom right. */
  position: number
  /** Ticked shooting fields (exif.ts keys), drawn in this order. */
  fields: string[]
  /** Hand-edited display values, cleared when the photo is replaced. */
  fieldValues: Record<string, string>
  transparent: boolean
  format: OutputFormat
  quality: number
  /** 0 = automatic (fit the 16 MP / 8192 output budget). */
  longEdge: number
}

export const MAX_CAPTION = 200
export const MIN_CAPTION_SIZE = 0.5

export function defaultsFrame(): FrameDoc {
  return {
    kind: 'frame',
    assetId: null,
    frame: 'solid',
    border: 6,
    bottom: 15,
    radius: 0,
    blur: 2,
    text: '',
    font: 'sans-serif',
    size: 2.5,
    opacity: 1,
    textColor: '#24282a',
    color: '#f3f1ea',
    secondColor: '#b3b8ac',
    position: 7,
    fields: [],
    fieldValues: {},
    transparent: false,
    format: 'image/jpeg',
    quality: 92,
    longEdge: 0,
  }
}

export type PresetName = 'light' | 'dark' | 'soft' | 'caption'

export const FRAME_PRESETS: Readonly<Record<PresetName, Readonly<Partial<FrameDoc>>>> = Object.freeze({
  light: { frame: 'solid', color: '#f3f1ea', border: 6, textColor: '#24282a' },
  dark: { frame: 'solid', color: '#16191b', border: 6, textColor: '#eeeeea' },
  soft: { frame: 'blur', border: 10, blur: 2, textColor: '#ffffff' },
  caption: { frame: 'bottom-bar', border: 2, bottom: 18, color: '#f3f1ea', textColor: '#24282a' },
})

export function applyPreset(d: FrameDoc, name: PresetName): FrameDoc {
  return { ...d, ...FRAME_PRESETS[name] }
}

// Cc except LF, plus bidi marks, embeddings, overrides and isolates.
const DROP_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu

/** Caption cleaning: CRLF/CR become LF, control and bidi characters are dropped, capped at 200 code points. */
export function cleanText(s: string): string {
  const cleaned = s.replace(/\r\n?/g, '\n').replace(DROP_RE, '').trim()
  const points = Array.from(cleaned)
  return points.length > MAX_CAPTION ? points.slice(0, MAX_CAPTION).join('') : cleaned
}

/** The text to draw: the cleaned caption, then one line of ticked shooting fields. */
export function captionText(d: FrameDoc, metadata: Record<string, string>): string {
  const values = d.fields
    .map((k) => cleanText(d.fieldValues[k] || metadata[k] || '').replace(/\n/g, ' '))
    .filter(Boolean)
  return [cleanText(d.text), values.join(' · ')].filter(Boolean).join('\n')
}
