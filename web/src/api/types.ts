// Response shapes for the public read API (see internal/api/read.go and
// internal/api/media.go). Field names match the JSON exactly.

export type Tier = 'w480' | 'w1280' | 'w2400' | 'w3840'
export const TIERS: readonly Tier[] = ['w480', 'w1280', 'w2400', 'w3840']

export type ImageFormat = 'avif' | 'webp' | 'jpeg'

/** One tier's URLs. The JPEG URL ends in `.jpg` even though the key is `jpeg`. */
export interface TierURLs {
  avif: string
  webp: string
  jpeg: string
}

/** Derived image set. `width`/`height` are the original pixel dimensions. */
export interface Media {
  width: number
  height: number
  tiers: Record<Tier, TierURLs>
}

/** Public EXIF subset. Every key is optional; location is never present. */
export interface Exif {
  camera?: string
  lens?: string
  focalLength?: number
  focalLength35mm?: number
  aperture?: number
  /** Display form from the pipeline: "1/250" below one second, else "2" or "2.5". */
  shutter?: string
  exposureSeconds?: number
  iso?: number
  exposureBias?: number
  /** DateTimeOriginal in Unix milliseconds (UTC, or wall clock as UTC). */
  takenAt?: number
}

/** 64 bins per channel. */
export type HistogramChannel = number[]
/** Four channels in order: luma, R, G, B. */
export type Histogram = [HistogramChannel, HistogramChannel, HistogramChannel, HistogramChannel]

/** A photo as seen inside a collection. */
export interface PhotoView {
  id: string
  title: string
  caption: string
  width: number | null
  height: number | null
  media: Media | null
  exif: Exif | null
  histogram: Histogram | null
  attribution: unknown
  downloadable: boolean
}

export type FrameLayout = 'full' | 'matted' | 'pair' | 'text'

export interface Frame {
  layout: FrameLayout
  matteRatio: number | null
  text: string | null
  photos: PhotoView[]
}

export interface OwnerRef {
  id: string
  name: string
}

export interface Collection {
  id: string
  title: string
  intro: string
  owner: OwnerRef
  license: string | null
  aiDeclaration: string | null
  originalDownload: boolean
  cover: PhotoView | null
  /** Unix milliseconds. */
  publishedAt: number | null
  frames: Frame[]
  /** Owner-only fields. */
  status?: string
  visibility?: string
  distribute?: boolean
}

/** A collection on a wall. */
export interface Card {
  id: string
  title: string
  owner: OwnerRef
  count: number
  cover: Media | null
}

export interface Neighbors {
  /** The wall the server actually used; the client must prefer it. */
  wall: string
  prev: Card | null
  next: Card | null
  strip: Card[]
}
