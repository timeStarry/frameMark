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
  /** Offset of takenAt's wall clock from UTC, in minutes, when the camera recorded one. */
  takenOffsetMinutes?: number
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
  /** Up to five preview images; never null. */
  previews: Media[]
  /** Owner-only fields. */
  status?: 'draft' | 'published'
  visibility?: 'private' | 'unlisted' | 'public'
}

/** GET /api/square. */
export interface SquarePage {
  featured: Card[]
  items: Card[]
  nextCursor: string | null
}

export interface Profile {
  id: string
  name: string
  bio: string
  wallLayout: 'salon' | 'grid'
}

/** An album on a user wall. Albums carry no previews. */
export interface AlbumCard {
  id: string
  title: string
  intro: string
  count: number
  cover: Media | null
}

/** GET /api/u/{id}. */
export interface UserWall {
  profile: Profile
  collections: Card[]
  albums: AlbumCard[]
}

/** GET /api/albums/{id}. */
export interface AlbumPage {
  id: string
  title: string
  intro: string
  owner: OwnerRef
  members: Card[]
}

export interface Neighbors {
  /** The wall the server actually used; the client must prefer it. */
  wall: string
  prev: Card | null
  next: Card | null
  strip: Card[]
}

// --- Owner API (internal/api/uploads.go, archive.go, prefs.go, profile.go) ---

export type PhotoStatus = 'uploading' | 'processing' | 'ready' | 'failed'

/** The owner view of a photo. Never carries location. */
export interface OwnerPhoto {
  id: string
  status: PhotoStatus
  error: string | null
  title: string
  caption: string
  width: number | null
  height: number | null
  format: string
  createdAt: number
  publicFields: string[]
  histogramPublic: boolean
  originalDownload: boolean
  exif: Exif | null
  media: Media | null
}

export interface ArchiveFacets {
  years: { year: number; count: number }[]
  cameras: { name: string; count: number }[]
  lenses: { name: string; count: number }[]
}

/** GET /api/archive. */
export interface ArchivePage {
  items: OwnerPhoto[]
  nextCursor: string | null
  facets: ArchiveFacets
}

export interface ArchiveQuery {
  year?: number
  camera?: string
  lens?: string
  focalMin?: number
  focalMax?: number
  inCollection?: boolean
  status?: PhotoStatus
}

export interface Watermark {
  text: string
  position: 'br' | 'bl' | 'tr' | 'tl' | 'center'
  opacity: number
  scale: number
}

/** GET/PUT /api/upload-prefs. */
export interface UploadPrefs {
  publicFields: string[]
  histogramPublic: boolean
  originalDownload: boolean
  watermark: Watermark | null
  defaultLicense: string | null
  defaultAiDeclaration: string | null
  locationMode: 'off' | 'archive'
  updatedAt: number | null
}

/** PUT /api/profile. */
export interface ProfileInput {
  name: string
  bio: string
  wallLayout: 'salon' | 'grid'
}

/** POST /api/uploads, 201: presigned PUT for the original. */
export interface UploadInit {
  photoId: string
  upload: { url: string; method: string; headers: Record<string, string> }
  expiresAt: number
}

// --- Curation desk (internal/api/collections.go, photos.go, read.go) ---

export type Visibility = 'private' | 'unlisted' | 'public'

/** A frame photo in the owner's read: effective exposure plus the raw override. */
export interface OwnerFramePhoto extends PhotoView {
  publicFields: string[]
  histogramPublic: boolean
  /** The photo_overrides row for this collection; a null key is not overridden. */
  override: { publicFields: string[] | null; histogramPublic: boolean | null } | null
}

export interface OwnerFrame {
  layout: FrameLayout
  matteRatio: number | null
  text: string | null
  photos: OwnerFramePhoto[]
}

/** GET /api/collections/{id} as the owner. */
export interface OwnerCollection extends Omit<Collection, 'frames' | 'cover' | 'status' | 'visibility' | 'distribute'> {
  status: 'draft' | 'published'
  visibility: Visibility
  distribute: boolean
  updatedAt: number
  cover: OwnerFramePhoto | null
  /** Owner's explicit cover choice; omitted when null. */
  coverPhotoId?: string | null
  frames: OwnerFrame[]
}

/** A frame as stored, in the write responses (frameView). */
export interface OwnerFrameRef {
  id: string
  position: number
  layout: FrameLayout
  matteRatio: number | null
  text: string | null
  photoIds: string[]
}

/** collectionView: returned by create (201), PUT fields, PUT frames, publish and unpublish. */
export interface OwnerCollectionWrite {
  id: string
  title: string
  intro: string
  status: 'draft' | 'published'
  visibility: Visibility
  distribute: boolean
  originalDownload: boolean
  license: string | null
  aiDeclaration: string | null
  coverPhotoId: string | null
  wallRank: number
  publishedAt: number | null
  createdAt: number
  updatedAt: number
  frames: OwnerFrameRef[]
}

/** PUT /api/collections/{id} body (collectionInput, without ifUpdatedAt). */
export interface CollectionFields {
  title: string
  intro: string
  visibility: Visibility
  distribute: boolean
  originalDownload: boolean
  license: string | null
  aiDeclaration: string | null
  coverPhotoId: string | null
}

/** Frame as written to the server (frameInput). */
export interface FrameInput {
  layout: FrameLayout
  matteRatio: number | null
  text: string | null
  photoIds: string[]
}

export interface OverrideInput {
  /** null with histogramPublic null drops the override (恢复默认). */
  publicFields: string[] | null
  histogramPublic: boolean | null
}

/** overrideView. updatedAt is the collection's after the write. */
export interface OverrideView {
  collectionId: string
  photoId: string
  publicFields: string[] | null
  histogramPublic: boolean | null
  updatedAt: number
}

/** PUT /api/photos/{id}: the owner photo plus the collections whose updatedAt it bumped. */
export interface PhotoMetaView extends OwnerPhoto {
  /** previousUpdatedAt is the value before this write; it differs from the desk's baseline when another tab wrote in between. */
  collections: { id: string; updatedAt: number; previousUpdatedAt: number }[]
}

export interface ExposureChange {
  kind: 'photos' | 'fields' | 'histogram' | 'original' | 'visibility' | 'square'
  detail: string
}

/** POST /api/collections/{id}/exposure-check body; no part is written. */
export interface ExposureCheckInput {
  collection?: CollectionFields
  frames?: FrameInput[]
  override?: OverrideInput & { photoId: string }
}

export interface ExposureCheck {
  widens: boolean
  changes: ExposureChange[]
}

/** POST /api/collections/{id}/publish?dry_run=1 (manifestView). */
export interface Manifest {
  photos: number
  publicFields: string[]
  histogram: boolean
  originalDownload: boolean
  visibility: Visibility
  inSquare: boolean
  /** The collection state this manifest describes; confirm sends it back as ifUpdatedAt. */
  updatedAt: number
}
