import { describe, expect, it, vi } from 'vitest'
import * as geometry from './geometry'
import { collageDefaults, type CollageDoc } from './collageDoc'
import { collageTarget, renderCollage } from './render-collage'
import { fakeBitmap, MockContext } from './mock-context'

function doc(partial: Partial<CollageDoc> = {}): CollageDoc {
  return { ...collageDefaults(), assetIds: ['a', 'b', 'c'], ...partial }
}

const bitmaps = () =>
  new Map([
    ['a', fakeBitmap(400, 300)],
    ['b', fakeBitmap(300, 400)],
    ['c', fakeBitmap(500, 500)],
  ])
const sizes = new Map([
  ['a', { width: 4000, height: 3000 }],
  ['b', { width: 3000, height: 4000 }],
  ['c', { width: 5000, height: 5000 }],
])

describe('renderCollage', () => {
  it('places every photo with geometry.cells and geometry.imageRect', () => {
    const cellsSpy = vi.spyOn(geometry, 'cells')
    const rectSpy = vi.spyOn(geometry, 'imageRect')
    const d = doc({ placements: { a: { x: 0, y: 50, fit: 'cover' } } })
    const ctx = new MockContext()
    renderCollage(ctx.asContext(), d, bitmaps(), sizes, 0.5)

    expect(cellsSpy).toHaveBeenCalledWith(d)
    const layout = geometry.cells(d)
    const draws = ctx.named('drawImage')
    expect(draws).toHaveLength(3)
    layout.forEach((cell, i) => {
      const p = d.placements[cell.id] ?? { x: 50, y: 50, fit: 'cover' }
      const r = geometry.imageRect(sizes.get(cell.id)!, cell, p)
      expect(draws[i]!.args.slice(1)).toEqual([r.x, r.y, r.width, r.height])
    })
    expect(rectSpy).toHaveBeenCalled()
    cellsSpy.mockRestore()
    rectSpy.mockRestore()
  })

  it('clips each cell with a radius bounded by half the cell', () => {
    const ctx = new MockContext()
    renderCollage(ctx.asContext(), doc({ radius: 9999 }), bitmaps(), sizes, 1)
    const cell = geometry.cells(doc())[0]!
    expect(ctx.named('roundRect')[0]!.args).toEqual([cell.x, cell.y, cell.width, cell.height, Math.min(cell.width, cell.height) / 2])
    expect(ctx.named('clip')).toHaveLength(3)
  })

  it('draws in logical units through setTransform and fills unless transparent PNG/WebP', () => {
    const ctx = new MockContext()
    renderCollage(ctx.asContext(), doc(), bitmaps(), sizes, 0.5)
    expect(ctx.named('setTransform')[0]!.args).toEqual([0.5, 0, 0, 0.5, 0, 0])
    expect(ctx.named('scale')).toHaveLength(0)
    expect(ctx.named('fillRect')[0]!.args).toEqual([0, 0, 1080, 1080])

    const png = new MockContext()
    renderCollage(png.asContext(), doc({ transparent: true, format: 'image/png' }), bitmaps(), sizes, 1)
    expect(png.named('fillRect')).toHaveLength(0)
    const jpeg = new MockContext()
    renderCollage(jpeg.asContext(), doc({ transparent: true }), bitmaps(), sizes, 1)
    expect(jpeg.named('fillRect')).toHaveLength(1)
  })

  it('refuses a missing bitmap', () => {
    const m = bitmaps()
    m.delete('b')
    expect(() => renderCollage(new MockContext().asContext(), doc(), m, sizes, 1)).toThrow('素材不可用')
  })
})

describe('collageTarget', () => {
  it('scales an oversized canvas down to the output budget', () => {
    const t = collageTarget(doc({ width: 8192, height: 8192 }))
    expect(t.scaledDown).toBe(true)
    expect(t.output.width * t.output.height).toBeLessThanOrEqual(16_000_000)
    expect(t.scale).toBeCloseTo(t.output.width / 8192)
  })

  it('keeps the default canvas and gives the preview size when asked', () => {
    expect(collageTarget(doc())).toMatchObject({ scaledDown: false, scale: 1, output: { width: 1080, height: 1080 } })
    expect(collageTarget(doc({ width: 3200, height: 1800 }), 1600).output).toEqual({ width: 1600, height: 900 })
  })
})
