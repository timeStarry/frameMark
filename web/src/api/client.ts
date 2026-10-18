import type { AlbumPage, Collection, Neighbors, SquarePage, UserWall } from './types'

/**
 * status 0: network error or unreadable body (show the retry screen).
 * status -1: the request was aborted (e.g. route change); callers ignore it.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; status: number }

const ABORTED = -1

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof DOMException && err.name === 'AbortError')
}

export async function getJSON<T>(url: string, signal?: AbortSignal): Promise<Result<T>> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    })
  } catch (err) {
    return { ok: false, status: isAbort(err, signal) ? ABORTED : 0 }
  }
  if (!res.ok) return { ok: false, status: res.status }
  try {
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    return { ok: false, status: isAbort(err, signal) ? ABORTED : 0 }
  }
}

export function getCollection(id: string, signal?: AbortSignal): Promise<Result<Collection>> {
  return getJSON<Collection>(`/api/collections/${encodeURIComponent(id)}`, signal)
}

/** `wall` is `square`, `user:{id}` or `album:{id}`; null lets the server pick. */
export function getNeighbors(id: string, wall: string | null, signal?: AbortSignal): Promise<Result<Neighbors>> {
  const q = wall ? `?wall=${encodeURIComponent(wall)}` : ''
  return getJSON<Neighbors>(`/api/collections/${encodeURIComponent(id)}/neighbors${q}`, signal)
}

export function getSquare(cursor: string | null, signal?: AbortSignal): Promise<Result<SquarePage>> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return getJSON<SquarePage>(`/api/square${q}`, signal)
}

export function getUser(id: string, signal?: AbortSignal): Promise<Result<UserWall>> {
  return getJSON<UserWall>(`/api/u/${encodeURIComponent(id)}`, signal)
}

export function getAlbum(id: string, signal?: AbortSignal): Promise<Result<AlbumPage>> {
  return getJSON<AlbumPage>(`/api/albums/${encodeURIComponent(id)}`, signal)
}

/** Download link for the original. Builds a string only; never fetched. */
export function originalURL(photoId: string, collectionId: string): string {
  return `/api/photos/${encodeURIComponent(photoId)}/original?collection=${encodeURIComponent(collectionId)}`
}
