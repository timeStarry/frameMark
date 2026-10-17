// In-memory cache of collections fetched ahead of horizontal navigation, so
// switching to a neighbour shows it at once. At most 4 entries, oldest out.
import type { Collection } from '../api/types'
import { getCollection } from '../api/client'

export const CACHE_MAX = 4

export interface CollectionCache {
  get(id: string): Collection | undefined
  put(c: Collection): void
  /** Fetch into the cache unless present or in flight. Resolves with the collection, or null on failure. */
  prefetch(id: string): Promise<Collection | null>
  clear(): void
}

export function createCollectionCache(max = CACHE_MAX): CollectionCache {
  const items = new Map<string, Collection>()
  const inflight = new Map<string, Promise<Collection | null>>()

  const put = (c: Collection) => {
    items.delete(c.id)
    items.set(c.id, c)
    while (items.size > max) items.delete(items.keys().next().value!)
  }

  return {
    get(id) {
      const c = items.get(id)
      if (c) put(c) // refresh recency
      return c
    },
    put,
    prefetch(id) {
      const hit = items.get(id)
      if (hit) return Promise.resolve(hit)
      const running = inflight.get(id)
      if (running) return running
      const p = getCollection(id).then((r) => {
        inflight.delete(id)
        if (!r.ok) return null
        put(r.data)
        return r.data
      })
      inflight.set(id, p)
      return p
    },
    clear() {
      items.clear()
      inflight.clear()
    },
  }
}

export const collectionCache = createCollectionCache()
