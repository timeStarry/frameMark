import { LIMITS } from './limits'
import type { Size } from './limits'

export type FrameKind = 'solid' | 'gradient' | 'blur' | 'bottom-bar'

export interface FrameBox {
  frame: FrameKind
  border: number
  bottom: number
}

export type Fit = 'cover' | 'contain'

export interface Placement {
  x: number
  y: number
  fit: Fit
}

export interface Cell {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface CollageLayout {
  assetIds: string[]
  width: number
  height: number
  mode: 'grid' | 'row' | 'column'
  columns: number
  gap: number
  padding: number
  radius: number
  placements: Record<string, Placement>
}

export function dimensions(d: FrameBox, source: Size): Size {
  const pad = Math.round((Math.min(source.width, source.height) * d.border) / 100)
  const bar =
    d.frame === 'bottom-bar'
      ? Math.round((Math.min(source.width, source.height) * d.bottom) / 100)
      : 0
  return {
    width: source.width + pad * 2,
    height: source.height + pad * 2 + bar,
  }
}

export function outputSize(size: Size, longEdge: number): Size {
  const ratio = longEdge ? longEdge / Math.max(size.width, size.height) : 1
  return {
    width: Math.max(1, Math.round(size.width * ratio)),
    height: Math.max(1, Math.round(size.height * ratio)),
  }
}

/** Largest integer long edge that keeps the output within the pixel and edge caps, or 0 when no scaling is needed. */
export function defaultLongEdge(target: Size): number {
  const long = Math.max(target.width, target.height)
  if (target.width * target.height <= LIMITS.maxOutputPixels && long <= LIMITS.maxEdge) {
    return 0
  }

  const fits = (edge: number): boolean => {
    const out = outputSize(target, edge)
    return out.width * out.height <= LIMITS.maxOutputPixels && Math.max(out.width, out.height) <= LIMITS.maxEdge
  }

  // Start from the analytic estimate, then correct for rounding in outputSize.
  const estimate = Math.sqrt(LIMITS.maxOutputPixels / (target.width * target.height)) * long
  let edge = Math.max(1, Math.min(LIMITS.maxEdge, Math.floor(estimate)))
  while (edge > 1 && !fits(edge)) {
    edge--
  }
  while (edge < LIMITS.maxEdge && fits(edge + 1)) {
    edge++
  }
  return edge
}

export function cells(d: CollageLayout): Cell[] {
  const n = d.assetIds.length
  if (!n) return []

  const cols = d.mode === 'row' ? n : d.mode === 'column' ? 1 : Math.min(d.columns, 6)
  const rows = d.mode === 'column' ? n : d.mode === 'row' ? 1 : Math.ceil(n / cols)
  const width = (d.width - d.padding * 2 - d.gap * (cols - 1)) / cols
  const height = (d.height - d.padding * 2 - d.gap * (rows - 1)) / rows
  if (!Number.isFinite(width * height) || width <= 0 || height <= 0) {
    throw new Error('间距或外边距过大，照片格子没有可用面积。')
  }

  return d.assetIds.map((id, i) => ({
    id,
    x: d.padding + (i % cols) * (width + d.gap),
    y: d.padding + Math.floor(i / cols) * (height + d.gap),
    width,
    height,
  }))
}

export function imageRect(source: Size, cell: Cell, p: Placement): Size & { x: number; y: number } {
  const pick = p.fit === 'contain' ? Math.min : Math.max
  const scale = pick(cell.width / source.width, cell.height / source.height)
  const width = source.width * scale
  const height = source.height * scale
  const nx = Math.max(0, Math.min(1, p.x / 100))
  const ny = Math.max(0, Math.min(1, p.y / 100))
  return {
    x: cell.x + (cell.width - width) * nx,
    y: cell.y + (cell.height - height) * ny,
    width,
    height,
  }
}

export function moveAsset(d: CollageLayout, id: string, delta: number): CollageLayout {
  const next = structuredClone(d)
  const index = next.assetIds.indexOf(id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= next.assetIds.length) return next
  next.assetIds.splice(index, 1)
  next.assetIds.splice(target, 0, id)
  return next
}

export function replaceAsset(d: CollageLayout, oldId: string, newId: string): CollageLayout {
  const next = structuredClone(d)
  const index = next.assetIds.indexOf(oldId)
  if (index < 0) return next
  next.assetIds[index] = newId
  next.placements[newId] = {
    ...(next.placements[oldId] ?? { x: 50, y: 50, fit: 'cover' }),
  }
  delete next.placements[oldId]
  return next
}
