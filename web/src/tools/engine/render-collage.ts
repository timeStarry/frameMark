import { cells, defaultLongEdge, imageRect, outputSize } from './geometry'
import type { Size } from './limits'
import type { CollageDoc } from './collageDoc'
import type { Target } from './render-frame'

export function collageTarget(d: CollageDoc, previewEdge?: number): Target {
  const logical = { width: d.width, height: d.height }
  const long = Math.max(logical.width, logical.height)
  const edge = previewEdge
    ? Math.min(previewEdge, long)
    : d.longEdge || defaultLongEdge(logical) || long
  const output = outputSize(logical, edge)
  return {
    logical,
    output,
    scale: output.width / logical.width,
    scaledDown: output.width * output.height < logical.width * logical.height,
  }
}

export function renderCollage(
  ctx: CanvasRenderingContext2D,
  d: CollageDoc,
  bitmaps: Map<string, CanvasImageSource>,
  sizes: Map<string, Size>,
  scale: number,
): void {
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  if (!d.transparent || d.format === 'image/jpeg') {
    ctx.fillStyle = d.color
    ctx.fillRect(0, 0, d.width, d.height)
  }

  const layout = cells(d)
  for (const cell of layout) {
    const bitmap = bitmaps.get(cell.id)
    const source = sizes.get(cell.id)
    if (!bitmap || !source) throw new Error('素材不可用，请重新导入。')
    const placement = d.placements[cell.id] ?? { x: 50, y: 50, fit: 'cover' as const }
    const rect = imageRect(source, cell, placement)
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(cell.x, cell.y, cell.width, cell.height, Math.min(d.radius, cell.width / 2, cell.height / 2))
    ctx.clip()
    ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height)
    ctx.restore()
  }
}
