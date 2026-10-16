import type { Collection, Neighbors } from './types'

/** status 0 means a network error, abort or unreadable body. */
export type Result<T> = { ok: true; data: T } | { ok: false; status: number }

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<Result<T>> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    })
  } catch {
    return { ok: false, status: 0 }
  }
  if (!res.ok) return { ok: false, status: res.status }
  try {
    return { ok: true, data: (await res.json()) as T }
  } catch {
    return { ok: false, status: 0 }
  }
}

export function getCollection(id: string, signal?: AbortSignal): Promise<Result<Collection>> {
  return getJSON<Collection>(`/api/collections/${encodeURIComponent(id)}`, signal)
}

/** `wall` is `square`, `user` or `album:{id}`; null lets the server pick. */
export function getNeighbors(id: string, wall: string | null, signal?: AbortSignal): Promise<Result<Neighbors>> {
  const q = wall ? `?wall=${encodeURIComponent(wall)}` : ''
  return getJSON<Neighbors>(`/api/collections/${encodeURIComponent(id)}/neighbors${q}`, signal)
}

/** Download link for the original. Builds a string only; never fetched. */
export function originalURL(photoId: string, collectionId: string): string {
  return `/api/photos/${encodeURIComponent(photoId)}/original?collection=${encodeURIComponent(collectionId)}`
}
