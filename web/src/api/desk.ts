// desk.ts — the curation desk's collection API (spec §3). Reads go through
// getJSON, writes through send; a 409 exposes the server's current updatedAt.
import { getJSON, type Result } from './client'
import { send, type WriteResult } from './write'
import type {
  CollectionFields,
  ExposureCheck,
  ExposureCheckInput,
  FrameInput,
  Manifest,
  OverrideInput,
  OverrideView,
  OwnerCollection,
  OwnerCollectionWrite,
  PhotoMetaView,
} from './types'

const enc = encodeURIComponent
const base = (id: string) => `/api/collections/${enc(id)}`

/** A guarded write: on a 409, conflictAt is the collection's current updatedAt. */
export type GuardedResult<T> = WriteResult<T> & { conflictAt?: number }

async function guarded<T>(method: 'PUT' | 'POST', url: string, body: unknown): Promise<GuardedResult<T>> {
  const r: GuardedResult<T> = await send<T>(method, url, body)
  if (!r.ok && r.status === 409 && typeof r.body?.updatedAt === 'number') r.conflictAt = r.body.updatedAt
  return r
}

function pickFields(f: CollectionFields): CollectionFields {
  const { title, intro, visibility, distribute, originalDownload, license, aiDeclaration, coverPhotoId } = f
  return { title, intro, visibility, distribute, originalDownload, license, aiDeclaration, coverPhotoId }
}

function pickFrame(f: FrameInput): FrameInput {
  const { layout, matteRatio, text, photoIds } = f
  return { layout, matteRatio, text, photoIds: [...photoIds] }
}

export function getOwnerCollection(id: string, signal?: AbortSignal): Promise<Result<OwnerCollection>> {
  return getJSON<OwnerCollection>(base(id), signal)
}

export function createCollection(title: string): Promise<WriteResult<OwnerCollectionWrite>> {
  return send<OwnerCollectionWrite>('POST', '/api/collections', { title })
}

/** ifUpdatedAt null omits the guard (force write). */
export function putCollection(
  id: string,
  f: CollectionFields,
  ifUpdatedAt: number | null,
): Promise<GuardedResult<OwnerCollectionWrite>> {
  const body: CollectionFields & { ifUpdatedAt?: number } = pickFields(f)
  if (ifUpdatedAt !== null) body.ifUpdatedAt = ifUpdatedAt
  return guarded<OwnerCollectionWrite>('PUT', base(id), body)
}

/** ifUpdatedAt null omits the guard (force write). */
export function putFrames(
  id: string,
  frames: FrameInput[],
  ifUpdatedAt: number | null,
): Promise<GuardedResult<OwnerCollectionWrite>> {
  const body: { frames: FrameInput[]; ifUpdatedAt?: number } = { frames: frames.map(pickFrame) }
  if (ifUpdatedAt !== null) body.ifUpdatedAt = ifUpdatedAt
  return guarded<OwnerCollectionWrite>('PUT', `${base(id)}/frames`, body)
}

/** ifUpdatedAt null omits the guard; an override can widen, so the desk always sends it. */
export function putOverride(
  id: string,
  photoId: string,
  o: OverrideInput,
  ifUpdatedAt: number | null = null,
): Promise<GuardedResult<OverrideView>> {
  const { publicFields, histogramPublic } = o
  const body: OverrideInput & { ifUpdatedAt?: number } = { publicFields, histogramPublic }
  if (ifUpdatedAt !== null) body.ifUpdatedAt = ifUpdatedAt
  return guarded<OverrideView>('PUT', `${base(id)}/overrides/${enc(photoId)}`, body)
}

export function putPhotoMeta(photoId: string, m: { title: string; caption: string }): Promise<WriteResult<PhotoMetaView>> {
  const { title, caption } = m
  return send<PhotoMetaView>('PUT', `/api/photos/${enc(photoId)}`, { title, caption })
}

export function exposureCheck(id: string, body: ExposureCheckInput): Promise<WriteResult<ExposureCheck>> {
  return send<ExposureCheck>('POST', `${base(id)}/exposure-check`, body)
}

export function publishDryRun(id: string): Promise<WriteResult<Manifest>> {
  return send<Manifest>('POST', `${base(id)}/publish?dry_run=1`)
}

/** ifUpdatedAt is the manifest's updatedAt: publish only the state the author confirmed. */
export function publish(id: string, ifUpdatedAt: number | null = null): Promise<GuardedResult<OwnerCollectionWrite>> {
  return guarded<OwnerCollectionWrite>('POST', `${base(id)}/publish`, ifUpdatedAt === null ? undefined : { ifUpdatedAt })
}

export function unpublish(id: string): Promise<WriteResult<OwnerCollectionWrite>> {
  return send<OwnerCollectionWrite>('POST', `${base(id)}/unpublish`)
}

/** 204 on success. */
export function deleteCollection(id: string): Promise<WriteResult<unknown>> {
  return send<unknown>('DELETE', base(id))
}
