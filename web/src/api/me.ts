// me.ts — the owner API: archive, photos, uploads, prefs, profile.
import { getJSON, type Result } from './client'
import { send, type WriteResult } from './write'
import type { ArchivePage, ArchiveQuery, OwnerPhoto, ProfileInput, UploadInit, UploadPrefs } from './types'

const enc = encodeURIComponent

/** Builds `/api/archive?…` with internal/api/archive.go's parameter names. */
function archiveURL(q: ArchiveQuery, cursor: string | null): string {
  const p = new URLSearchParams()
  if (q.year !== undefined) p.set('year', String(q.year))
  if (q.camera !== undefined && q.camera !== '') p.set('camera', q.camera)
  if (q.lens !== undefined && q.lens !== '') p.set('lens', q.lens)
  if (q.focalMin !== undefined) p.set('focal_min', String(q.focalMin))
  if (q.focalMax !== undefined) p.set('focal_max', String(q.focalMax))
  if (q.inCollection !== undefined) p.set('in_collection', q.inCollection ? 'true' : 'false')
  if (q.status !== undefined) p.set('status', q.status)
  if (cursor) p.set('cursor', cursor)
  const s = p.toString()
  return s ? `/api/archive?${s}` : '/api/archive'
}

export function getArchive(q: ArchiveQuery, cursor: string | null, signal?: AbortSignal): Promise<Result<ArchivePage>> {
  return getJSON<ArchivePage>(archiveURL(q, cursor), signal)
}

export function getPhoto(id: string, signal?: AbortSignal): Promise<Result<OwnerPhoto>> {
  return getJSON<OwnerPhoto>(`/api/photos/${enc(id)}`, signal)
}

export function deletePhoto(id: string): Promise<WriteResult<unknown>> {
  return send<unknown>('DELETE', `/api/photos/${enc(id)}`)
}

/** 201 carries an UploadInit; 200 is the owner's existing photo (duplicate file). */
export function createUpload(f: {
  filename: string
  bytes: number
  sha256: string
  contentType: string
  title?: string
  derivedFrom?: string[]
  toolOutput?: boolean
}): Promise<WriteResult<UploadInit | OwnerPhoto>> {
  const { filename, bytes, sha256, contentType, title, derivedFrom, toolOutput } = f
  const body: Record<string, unknown> = { filename, bytes, sha256, contentType }
  if (title !== undefined) body.title = title
  if (derivedFrom !== undefined) body.derivedFrom = derivedFrom
  if (toolOutput !== undefined) body.toolOutput = toolOutput
  return send<UploadInit | OwnerPhoto>('POST', '/api/uploads', body)
}

export function completeUpload(id: string): Promise<WriteResult<OwnerPhoto>> {
  return send<OwnerPhoto>('POST', `/api/uploads/${enc(id)}/complete`)
}

export function getPrefs(signal?: AbortSignal): Promise<Result<UploadPrefs>> {
  return getJSON<UploadPrefs>('/api/upload-prefs', signal)
}

export function putPrefs(p: Omit<UploadPrefs, 'updatedAt'>): Promise<WriteResult<UploadPrefs>> {
  const { publicFields, histogramPublic, originalDownload, watermark, defaultLicense, defaultAiDeclaration, locationMode } = p
  return send<UploadPrefs>('PUT', '/api/upload-prefs', {
    publicFields,
    histogramPublic,
    originalDownload,
    watermark,
    defaultLicense,
    defaultAiDeclaration,
    locationMode,
  })
}

export function putProfile(p: ProfileInput): Promise<WriteResult<unknown>> {
  const { name, bio, wallLayout } = p
  return send<unknown>('PUT', '/api/profile', { name, bio, wallLayout })
}
