// preview.ts — maps the desk's local state to the visitor Collection shape for
// the preview pane (spec §4.1). Pure. Each photo's exif keeps only the keys its
// effective publicFields allow, mirroring the set(...) table in
// internal/api/read.go; the histogram survives only when histogramPublic.
import type { Collection, CollectionFields, Exif, Frame, Histogram, OwnerRef, PhotoView } from '../api/types'
import { cleanText, type DeskPhoto, type Seq } from './sequence'

/** What the desk knows about a photo beyond the DeskPhoto in the sequence. */
export interface PhotoDetail {
  title: string
  caption: string
  exif: Exif | null
  histogram: Histogram | null
  attribution: unknown
  /** Effective public fields in this collection (override applied). */
  publicFields: string[]
  /** Effective histogram exposure in this collection (override applied). */
  histogramPublic: boolean
}

/** Public field key → the exif keys it reveals (internal/api/read.go). */
export const EXIF_KEYS: Readonly<Record<string, readonly (keyof Exif)[]>> = {
  camera: ['camera'],
  lens: ['lens'],
  focal_length: ['focalLength', 'focalLength35mm'],
  aperture: ['aperture'],
  shutter: ['shutter', 'exposureSeconds'],
  iso: ['iso'],
  exposure_bias: ['exposureBias'],
  taken_date: ['takenAt', 'takenOffsetMinutes'],
}

/** Keeps only the exif keys the fields allow; null when nothing is left (as the server omits it). */
export function filterExif(exif: Exif | null, publicFields: readonly string[]): Exif | null {
  if (!exif) return null
  const out: Record<string, unknown> = {}
  for (const field of publicFields) {
    if (!Object.prototype.hasOwnProperty.call(EXIF_KEYS, field)) continue
    for (const k of EXIF_KEYS[field] ?? []) {
      if (exif[k] !== undefined) out[k] = exif[k]
    }
  }
  return Object.keys(out).length > 0 ? (out as Exif) : null
}

export interface PreviewBase {
  id: string
  owner: OwnerRef
  publishedAt: number | null
}

function photoView(p: DeskPhoto, d: PhotoDetail | undefined, originalDownload: boolean): PhotoView {
  return {
    id: p.id,
    title: d?.title ?? p.title,
    caption: d?.caption ?? '',
    width: p.width,
    height: p.height,
    media: p.media,
    exif: d ? filterExif(d.exif, d.publicFields) : null,
    histogram: d?.histogramPublic ? (d.histogram ?? null) : null,
    attribution: d?.attribution ?? null,
    downloadable: originalDownload,
  }
}

export function toPreview(
  base: PreviewBase,
  fields: CollectionFields,
  seq: Seq,
  photos: Readonly<Record<string, PhotoDetail>>,
): Collection {
  const frames: Frame[] = seq.map((f) => ({
    layout: f.layout,
    matteRatio: f.layout === 'matted' ? f.matteRatio : null,
    text: f.layout === 'text' ? cleanText(f.text ?? '') : null,
    photos: f.photos.map((p) => photoView(p, photos[p.id], fields.originalDownload)),
  }))
  const all = frames.flatMap((f) => f.photos)
  const cover = all.find((p) => p.id === fields.coverPhotoId) ?? all[0] ?? null
  return {
    id: base.id,
    title: fields.title,
    intro: fields.intro,
    owner: base.owner,
    license: fields.license,
    aiDeclaration: fields.aiDeclaration,
    originalDownload: fields.originalDownload,
    cover,
    publishedAt: base.publishedAt,
    frames,
  }
}
