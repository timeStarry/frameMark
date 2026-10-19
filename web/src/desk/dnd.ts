// dnd.ts — native drag-and-drop payloads between the desk's archive and
// sequence columns (spec §4.2, §4.3). Every drag has a keyboard equivalent.
import type { DeskPhoto } from './sequence'

/** Archive photos: a JSON array of DeskPhoto, in archive order. */
export const PHOTO_TYPE = 'application/x-markr-photo'
/** A frame moved within the sequence: its client key. */
export const FRAME_TYPE = 'application/x-markr-frame'

/** dataTransfer.types is readable during dragover; getData is not. */
export function hasType(e: DragEvent, type: string): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes(type)
}

function isPhoto(v: unknown): v is DeskPhoto {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  const dim = (x: unknown) => x === null || typeof x === 'number'
  return (
    typeof o.id === 'string' &&
    o.id !== '' &&
    typeof o.title === 'string' &&
    dim(o.width) &&
    dim(o.height) &&
    (o.media === null || typeof o.media === 'object')
  )
}

export function writePhotos(dt: DataTransfer, photos: DeskPhoto[]): void {
  const payload: DeskPhoto[] = photos.map((p) => ({ id: p.id, title: p.title, media: p.media, width: p.width, height: p.height }))
  dt.setData(PHOTO_TYPE, JSON.stringify(payload))
  dt.effectAllowed = 'copy'
}

/** The dropped photos; empty for a missing or malformed payload. */
export function readPhotos(dt: DataTransfer | null): DeskPhoto[] {
  const raw = dt?.getData(PHOTO_TYPE)
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) && v.every(isPhoto) ? v : []
  } catch {
    return []
  }
}

export function writeFrame(dt: DataTransfer, key: string): void {
  dt.setData(FRAME_TYPE, key)
  dt.effectAllowed = 'move'
}

export function readFrame(dt: DataTransfer | null): string {
  return dt?.getData(FRAME_TYPE) ?? ''
}
