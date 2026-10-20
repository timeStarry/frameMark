import type { CollageLayout } from './geometry'
import type { OutputFormat } from './frameDoc'

export interface CollageDoc extends CollageLayout {
  kind: 'collage'
  /** Background colour. */
  color: string
  /** Transparent background; only honoured for PNG and WebP. */
  transparent: boolean
  format: OutputFormat
  quality: number
  /** 0 = automatic (fit the 16 MP / 8192 output budget). */
  longEdge: number
}

export function collageDefaults(): CollageDoc {
  return {
    kind: 'collage',
    assetIds: [],
    width: 1080,
    height: 1080,
    mode: 'grid',
    columns: 2,
    gap: 16,
    padding: 24,
    radius: 0,
    color: '#f3f1ea',
    transparent: false,
    format: 'image/jpeg',
    quality: 92,
    longEdge: 0,
    placements: {},
  }
}

export const defaultsCollage = collageDefaults
