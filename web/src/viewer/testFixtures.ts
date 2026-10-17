// Test-only fixtures shared by the viewer component tests. Never imported by app code.
import { config } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { Card, Collection, Exif, Frame, Histogram, Media, Neighbors, PhotoView, Tier } from '../api/types'

export function media(id: string, width = 6000, height = 4000): Media {
  const tiers = {} as Media['tiers']
  for (const t of ['w480', 'w1280', 'w2400', 'w3840'] as Tier[]) {
    tiers[t] = { avif: `/m/${id}/${t}.avif`, webp: `/m/${id}/${t}.webp`, jpeg: `/m/${id}/${t}.jpg` }
  }
  return { width, height, tiers }
}

export const EXIF: Exif = {
  camera: 'X100V',
  lens: 'Fujinon 23mm',
  focalLength: 23,
  focalLength35mm: 35,
  aperture: 2,
  shutter: '1/250',
  iso: 200,
  exposureBias: 0.7,
  takenAt: Date.UTC(2026, 4, 3, 10),
}

/** Four channels of 64 bins (luma, R, G, B). */
export function histogram(): Histogram {
  const ch = (k: number) => Array.from({ length: 64 }, (_, i) => ((i * k) % 64) + 1)
  return [ch(1), ch(3), ch(5), ch(7)]
}

export function photo(id: string, over: Partial<PhotoView> = {}): PhotoView {
  return {
    id,
    title: `标题${id}`,
    caption: `图注${id}`,
    width: 6000,
    height: 4000,
    media: media(id),
    exif: null,
    histogram: null,
    attribution: null,
    downloadable: false,
    ...over,
  }
}

export function fullFrame(p: PhotoView): Frame {
  return { layout: 'full', matteRatio: null, text: null, photos: [p] }
}

export function textFrame(text: string): Frame {
  return { layout: 'text', matteRatio: null, text, photos: [] }
}

export function pairFrame(...ps: PhotoView[]): Frame {
  return { layout: 'pair', matteRatio: null, text: null, photos: ps }
}

export function collection(frames: Frame[], over: Partial<Collection> = {}): Collection {
  return {
    id: 'c1',
    title: '海边',
    intro: '',
    owner: { id: 'u1', name: '阿树' },
    license: null,
    aiDeclaration: null,
    originalDownload: false,
    cover: null,
    publishedAt: null,
    frames,
    ...over,
  }
}

export function card(id: string, title: string, ownerName = '阿树', ownerId = 'u1', over: Partial<Card> = {}): Card {
  return {
    id,
    title,
    owner: { id: ownerId, name: ownerName },
    count: 4,
    cover: media(`cover-${id}`),
    previews: [media(`p-${id}-1`), media(`p-${id}-2`), media(`p-${id}-3`)],
    ...over,
  }
}

export function neighbors(over: Partial<Neighbors> = {}): Neighbors {
  return { wall: 'square', prev: null, next: null, strip: [], ...over }
}

/**
 * Installs a catch-all memory router for every mount in the calling test file,
 * so components with RouterLink render without a real app router.
 */
export function useTestRouter(): void {
  config.global.plugins = [
    createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] }),
  ]
}
