// <link rel="preload"> management for neighbouring frames (spec §4, §5.1).
// Only derived AVIF tiers are ever preloaded, never the original.

import type { Frame } from '../api/types'
import { sizesFor, srcset } from './media'

export interface PreloadEntry {
  /** Stable identity, used to diff links across updates. */
  key: string
  srcset: string
  sizes: string
}

/** Entries for the frames directly before and after `current` (1-based). The end frame has none. */
export function neighborEntries(frames: readonly Frame[], current: number): PreloadEntry[] {
  const out: PreloadEntry[] = []
  for (const n of [current - 1, current + 1]) {
    const frame = frames[n - 1]
    if (!frame || frame.layout === 'text') continue
    for (const p of frame.photos) {
      if (!p.media) continue
      const set = srcset(p.media, 'avif')
      if (!set || set.includes('/original')) continue
      out.push({ key: `${n}:${p.id}`, srcset: set, sizes: sizesFor(frame.layout, frame.photos.length) })
    }
  }
  return out
}

export interface Preloader {
  /** Make the document's preload links exactly `entries`. */
  set(entries: readonly PreloadEntry[]): void
  /** Remove links whose key is not in `entries`, without adding any. */
  prune(entries: readonly PreloadEntry[]): void
  clear(): void
}

export function createPreloader(doc: Document = document): Preloader {
  const links = new Map<string, HTMLLinkElement>()

  const prune = (entries: readonly PreloadEntry[]) => {
    const want = new Set(entries.map((e) => e.key))
    for (const [key, link] of links) {
      if (!want.has(key)) {
        link.remove()
        links.delete(key)
      }
    }
  }

  const set = (entries: readonly PreloadEntry[]) => {
    prune(entries)
    for (const e of entries) {
      if (links.has(e.key)) continue
      const link = doc.createElement('link')
      link.rel = 'preload'
      link.setAttribute('as', 'image')
      link.setAttribute('type', 'image/avif')
      link.setAttribute('imagesrcset', e.srcset)
      link.setAttribute('imagesizes', e.sizes)
      doc.head.appendChild(link)
      links.set(e.key, link)
    }
  }

  return { set, prune, clear: () => prune([]) }
}
