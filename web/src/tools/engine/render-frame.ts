import { defaultLongEdge, dimensions, outputSize } from './geometry'
import type { Size } from './limits'
import { captionText, MIN_CAPTION_SIZE, type FrameDoc } from './frameDoc'

export interface PhotoRect {
  x: number
  y: number
  width: number
  height: number
}

export interface Target {
  logical: Size
  output: Size
  scale: number
  scaledDown: boolean
}

export type CaptionLayout =
  | { fits: false }
  | {
      fits: true
      lines: string[]
      fontPx: number
      lineHeight: number
      x: number
      y: number
      align: CanvasTextAlign
    }

export function photoRect(d: Pick<FrameDoc, 'frame' | 'border' | 'bottom'>, source: Size): PhotoRect {
  const pad = Math.round((Math.min(source.width, source.height) * d.border) / 100)
  return { x: pad, y: pad, width: source.width, height: source.height }
}

export function frameTarget(d: FrameDoc, source: Size, previewEdge?: number): Target {
  const logical = dimensions(d, source)
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

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let current = ''
    for (const char of paragraph) {
      if (current && ctx.measureText(current + char).width > maxWidth) {
        lines.push(current)
        current = char
      } else {
        current += char
      }
    }
    lines.push(current)
  }
  return lines
}

function insetFor(source: Size, pad: number): number {
  if (pad <= 0) return 0
  const hint = Math.min(source.width, source.height) * 0.025
  return Math.max(2, Math.min(pad * 0.25, hint))
}

function band(d: FrameDoc, source: Size, logical: Size, photo: PhotoRect): { x: number; y: number; width: number; height: number } {
  const inset = insetFor(source, Math.min(photo.x, photo.y))
  if (d.frame === 'bottom-bar') {
    const bar = logical.height - photo.y - photo.height
    const barInset = insetFor(source, bar)
    return {
      x: barInset,
      y: photo.y + photo.height + barInset,
      width: logical.width - barInset * 2,
      height: bar - barInset * 2,
    }
  }
  const row = Math.floor(d.position / 3)
  const col = d.position % 3
  const bands = [
    { x: inset, y: inset, width: logical.width - inset * 2, height: photo.y - inset * 2 },
    { x: inset, y: photo.y + photo.height + inset, width: logical.width - inset * 2, height: logical.height - photo.y - photo.height - inset * 2 },
    { x: inset, y: photo.y, width: photo.x - inset * 2, height: photo.height },
    { x: photo.x + photo.width + inset, y: photo.y, width: logical.width - photo.x - photo.width - inset * 2, height: photo.height },
  ]
  if (row === 0) return bands[0]!
  if (row === 2) return bands[1]!
  if (col === 0) return bands[2]!
  if (col === 2) return bands[3]!
  return bands.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
}

function tryLayout(
  ctx: CanvasRenderingContext2D,
  d: FrameDoc,
  source: Size,
  text: string,
  fontPx: number,
): CaptionLayout {
  const logical = dimensions(d, source)
  const photo = photoRect(d, source)
  const area = band(d, source, logical, photo)
  if (area.width <= 0 || area.height <= 0) return { fits: false }

  ctx.font = `${fontPx}px ${d.font}`
  const lines = wrap(ctx, text, area.width)
  const lineHeight = fontPx * 1.4
  const height = lines.length * lineHeight
  if (height > area.height + 0.5) return { fits: false }

  const col = d.position % 3
  const align: CanvasTextAlign = col === 0 ? 'left' : col === 1 ? 'center' : 'right'
  const row = Math.floor(d.position / 3)
  const x = col === 0 ? area.x : col === 1 ? area.x + area.width / 2 : area.x + area.width
  const y =
    row === 0 ? area.y : row === 2 ? area.y + area.height - height : area.y + (area.height - height) / 2
  return { fits: true, lines, fontPx, lineHeight, x, y, align }
}

export function layoutCaption(
  d: FrameDoc,
  source: Size,
  ctx: CanvasRenderingContext2D,
  metadata: Record<string, string> = {},
): CaptionLayout {
  const text = captionText(d, metadata)
  if (!text) return { fits: true, lines: [], fontPx: 0, lineHeight: 0, x: 0, y: 0, align: 'left' }

  const short = Math.min(source.width, source.height)
  const minPx = (short * MIN_CAPTION_SIZE) / 100
  const startPx = Math.max(minPx, (short * d.size) / 100)
  const step = Math.max(0.5, short * 0.0004)
  for (let fontPx = startPx; fontPx > minPx; fontPx -= step) {
    const layout = tryLayout(ctx, d, source, text, fontPx)
    if (layout.fits) return layout
  }
  const last = tryLayout(ctx, d, source, text, minPx)
  return last.fits ? last : { fits: false }
}

function fillBackground(ctx: CanvasRenderingContext2D, d: FrameDoc, w: number, h: number): void {
  const skip = d.transparent && d.format !== 'image/jpeg' && d.frame === 'solid'
  if (skip) return
  ctx.fillStyle = d.color
  if (d.frame === 'gradient') {
    const gradient = ctx.createLinearGradient(0, 0, w, h)
    gradient.addColorStop(0, d.color)
    gradient.addColorStop(1, d.secondColor)
    ctx.fillStyle = gradient
  }
  ctx.fillRect(0, 0, w, h)
}

function drawBlur(
  ctx: CanvasRenderingContext2D,
  d: FrameDoc,
  bitmap: CanvasImageSource,
  source: Size,
  logical: Size,
  scale: number,
): void {
  const radius = (Math.min(source.width, source.height) * d.blur) / 100 * scale
  ctx.save()
  ctx.filter = `blur(${radius}px)`
  const bw = (bitmap as { width: number }).width
  const bh = (bitmap as { height: number }).height
  const r = Math.max(logical.width / bw, logical.height / bh) * 1.15
  ctx.drawImage(bitmap, (logical.width - bw * r) / 2, (logical.height - bh * r) / 2, bw * r, bh * r)
  ctx.restore()
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  d: FrameDoc,
  bitmap: CanvasImageSource,
  source: Size,
  scale: number,
  metadata: Record<string, string> = {},
): { fits: boolean } {
  const logical = dimensions(d, source)
  const photo = photoRect(d, source)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  fillBackground(ctx, d, logical.width, logical.height)
  if (d.frame === 'blur') {
    drawBlur(ctx, d, bitmap, source, logical, scale)
  }
  ctx.save()
  ctx.beginPath()
  const radius = (Math.min(source.width, source.height) * d.radius) / 100
  ctx.roundRect(photo.x, photo.y, photo.width, photo.height, radius)
  ctx.clip()
  ctx.drawImage(bitmap, photo.x, photo.y, photo.width, photo.height)
  ctx.restore()

  const layout = layoutCaption(d, source, ctx, metadata)
  if (!layout.fits) return { fits: false }
  if (layout.lines.length) {
    ctx.font = `${layout.fontPx}px ${d.font}`
    ctx.fillStyle = d.textColor
    ctx.globalAlpha = d.opacity
    ctx.textAlign = layout.align
    ctx.textBaseline = 'top'
    layout.lines.forEach((line, i) => ctx.fillText(line, layout.x, layout.y + i * layout.lineHeight))
    ctx.globalAlpha = 1
  }
  return { fits: true }
}
