// Curation desk sequence model (spec §4.3). Pure and immutable: every operation
// returns a new array, or the input itself when the edit is out of range or
// illegal. Rules mirror internal/api/collections.go.
import type { FrameLayout, Media } from '../api/types'

export interface DeskPhoto {
  id: string
  title: string
  media: Media | null
  width: number | null
  height: number | null
}

export interface DeskFrame {
  /** Client-only identity, stable across edits that keep the frame. */
  key: string
  layout: FrameLayout
  matteRatio: number | null
  text: string | null
  photos: DeskPhoto[]
}

export type Seq = readonly DeskFrame[]

/** Frame as written to the server. Task 3 may move this into api/types.ts. */
export interface FrameInput {
  layout: FrameLayout
  matteRatio: number | null
  text: string | null
  photoIds: string[]
}

/** Minimal shape of an owner collection that fromOwner reads. */
export interface OwnerSequenceSource {
  frames: readonly {
    layout: FrameLayout
    matteRatio: number | null
    text: string | null
    photos: readonly DeskPhoto[]
  }[]
}

export const MAX_FRAMES = 200
export const MAX_TEXT = 2000
export const MATTE_MIN = 0.5
export const MATTE_MAX = 0.95
export const MATTE_DEFAULT = 0.8

// Go's unicode.IsSpace set (strings.TrimSpace). Unlike String.prototype.trim it
// excludes U+FEFF and includes U+0085.
const GO_SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const TRIM_RE = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, 'gu')
// Cc except LF, plus bidi embedding/override/isolate controls.
const DROP_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu

/**
 * Mirrors cleanText(s, true) in internal/api/collections.go: CRLF/CR become
 * LF, other control and bidi characters are removed, and the result is trimmed.
 */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(DROP_RE, '').replace(TRIM_RE, '')
}

let keySeq = 0
function newKey(): string {
  keySeq += 1
  return `f${keySeq}`
}

const inRange = (s: Seq, i: number) => Number.isInteger(i) && i >= 0 && i < s.length

function fullFrame(photo: DeskPhoto): DeskFrame {
  return { key: newKey(), layout: 'full', matteRatio: null, text: null, photos: [photo] }
}

function replaceAt(s: Seq, index: number, frame: DeskFrame): Seq {
  const out = s.slice()
  out[index] = frame
  return out
}

export function fromOwner(c: OwnerSequenceSource): Seq {
  return c.frames.map((f) => ({
    key: newKey(),
    layout: f.layout,
    matteRatio: f.layout === 'matted' ? f.matteRatio : null,
    text: f.layout === 'text' ? f.text : null,
    photos: f.photos.map((p) => ({ id: p.id, title: p.title, media: p.media, width: p.width, height: p.height })),
  }))
}

export function toInput(s: Seq): FrameInput[] {
  return s.map((f) => ({
    layout: f.layout,
    matteRatio: f.layout === 'matted' ? f.matteRatio : null,
    text: f.layout === 'text' ? cleanText(f.text ?? '') : null,
    photoIds: f.photos.map((p) => p.id),
  }))
}

/** One full frame per photo, inserted at `at` (0..length). */
export function insertPhotos(s: Seq, at: number, photos: DeskPhoto[]): Seq {
  if (!Number.isInteger(at) || at < 0 || at > s.length) return s
  if (photos.length === 0 || s.length + photos.length > MAX_FRAMES) return s
  return [...s.slice(0, at), ...photos.map(fullFrame), ...s.slice(at)]
}

/** An empty text frame; invalid until its text is filled in. */
export function insertText(s: Seq, at: number): Seq {
  if (!Number.isInteger(at) || at < 0 || at > s.length) return s
  if (s.length >= MAX_FRAMES) return s
  const frame: DeskFrame = { key: newKey(), layout: 'text', matteRatio: null, text: '', photos: [] }
  return [...s.slice(0, at), frame, ...s.slice(at)]
}

export function remove(s: Seq, index: number): Seq {
  if (!inRange(s, index)) return s
  return [...s.slice(0, index), ...s.slice(index + 1)]
}

/** Moves the frame at `from` so it ends up at index `to`. */
export function move(s: Seq, from: number, to: number): Seq {
  if (!inRange(s, from) || !inRange(s, to) || from === to) return s
  const out = s.slice()
  out.splice(to, 0, ...out.splice(from, 1))
  return out
}

export function allowedLayouts(f: DeskFrame): FrameLayout[] {
  const n = f.photos.length
  if (n === 0) return ['text']
  if (n === 1) return ['full', 'matted']
  if (n <= 3) return ['pair']
  return []
}

export function setLayout(s: Seq, index: number, layout: FrameLayout): Seq {
  const f = s[index]
  if (!f || !inRange(s, index)) return s
  if (f.layout === layout || !allowedLayouts(f).includes(layout)) return s
  const matteRatio = layout === 'matted' ? (f.matteRatio ?? MATTE_DEFAULT) : null
  return replaceAt(s, index, { ...f, layout, matteRatio })
}

export function setMatte(s: Seq, index: number, ratio: number): Seq {
  const f = s[index]
  if (!f || !inRange(s, index) || f.layout !== 'matted' || Number.isNaN(ratio)) return s
  const clamped = Math.min(MATTE_MAX, Math.max(MATTE_MIN, ratio))
  return replaceAt(s, index, { ...f, matteRatio: clamped })
}

export function setText(s: Seq, index: number, text: string): Seq {
  const f = s[index]
  if (!f || !inRange(s, index) || f.layout !== 'text') return s
  return replaceAt(s, index, { ...f, text })
}

const isSingle = (f: DeskFrame) => (f.layout === 'full' || f.layout === 'matted') && f.photos.length === 1

/**
 * Moves the single photo of a full/matted frame into a full/matted frame or a
 * pair of 2, producing a pair. The target keeps its key; `from` is removed.
 */
export function merge(s: Seq, from: number, into: number): Seq {
  const src = s[from]
  const dst = s[into]
  if (!src || !dst || !inRange(s, from) || !inRange(s, into) || from === into) return s
  if (!isSingle(src)) return s
  if (!isSingle(dst) && !(dst.layout === 'pair' && dst.photos.length === 2)) return s
  const photo = src.photos[0]
  if (!photo || dst.photos.some((p) => p.id === photo.id)) return s
  const merged: DeskFrame = { ...dst, layout: 'pair', matteRatio: null, text: null, photos: [...dst.photos, photo] }
  return remove(replaceAt(s, into, merged), from)
}

/** Replaces a pair with one full frame per photo, in place. */
export function split(s: Seq, index: number): Seq {
  const f = s[index]
  if (!f || !inRange(s, index) || f.layout !== 'pair') return s
  const photos = f.photos
  if (s.length - 1 + photos.length > MAX_FRAMES) return s
  return [...s.slice(0, index), ...photos.map(fullFrame), ...s.slice(index + 1)]
}

export type Validity = { ok: true } | { ok: false; index: number; reason: string }

/** Reports the first frame the server would reject. */
export function isValid(s: Seq): Validity {
  for (const [i, f] of s.entries()) {
    if (i >= MAX_FRAMES) return { ok: false, index: i, reason: `a collection holds at most ${MAX_FRAMES} frames` }
    const n = f.photos.length
    switch (f.layout) {
      case 'text': {
        const len = [...cleanText(f.text ?? '')].length
        if (len === 0) return { ok: false, index: i, reason: 'text frame is empty' }
        if (len > MAX_TEXT) return { ok: false, index: i, reason: `text is longer than ${MAX_TEXT} characters` }
        if (n !== 0) return { ok: false, index: i, reason: 'text frame cannot hold photos' }
        break
      }
      case 'pair':
        if (n < 2 || n > 3) return { ok: false, index: i, reason: 'pair needs 2 to 3 photos' }
        if (new Set(f.photos.map((p) => p.id)).size !== n) return { ok: false, index: i, reason: 'pair photos must differ' }
        break
      case 'full':
      case 'matted':
        if (n !== 1) return { ok: false, index: i, reason: `${f.layout} frame needs exactly 1 photo` }
        if (f.layout === 'matted' && (f.matteRatio === null || f.matteRatio < MATTE_MIN || f.matteRatio > MATTE_MAX)) {
          return { ok: false, index: i, reason: 'matte ratio must be 0.5 to 0.95' }
        }
        break
    }
  }
  return { ok: true }
}

export function photoIds(s: Seq): Set<string> {
  const ids = new Set<string>()
  for (const f of s) for (const p of f.photos) ids.add(p.id)
  return ids
}
