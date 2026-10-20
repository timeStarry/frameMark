import { describe, expect, it } from 'vitest'
import {
  cells,
  defaultLongEdge,
  dimensions,
  imageRect,
  moveAsset,
  outputSize,
  replaceAsset,
  type CollageLayout,
} from './geometry'

const frame = { frame: 'solid' as const, border: 6, bottom: 15 }

function collage(partial: Partial<CollageLayout> = {}): CollageLayout {
  return {
    assetIds: [],
    width: 1080,
    height: 1080,
    mode: 'grid',
    columns: 2,
    gap: 16,
    padding: 24,
    radius: 0,
    placements: {},
    ...partial,
  }
}

describe('dimensions / outputSize', () => {
  it('uses source coordinates and scales only at the output boundary', () => {
    expect(dimensions(frame, { width: 4000, height: 3000 })).toEqual({ width: 4360, height: 3360 })
    expect(dimensions({ ...frame, frame: 'bottom-bar' }, { width: 4000, height: 3000 })).toEqual({
      width: 4360,
      height: 3810,
    })
    expect(outputSize({ width: 4000, height: 3000 }, 1600)).toEqual({ width: 1600, height: 1200 })
    expect(outputSize({ width: 4000, height: 3000 }, 0)).toEqual({ width: 4000, height: 3000 })
    expect(outputSize({ width: 1, height: 8192 }, 1)).toEqual({ width: 1, height: 1 })
  })
})

describe('defaultLongEdge', () => {
  it('returns 0 when the target already fits the output budget', () => {
    expect(defaultLongEdge({ width: 4000, height: 4000 })).toBe(0)
    expect(defaultLongEdge({ width: 8192, height: 1 })).toBe(0)
  })

  it('picks the largest long edge for a 20 MP photo grown by a 6% frame', () => {
    const source = { width: 5472, height: 3648 }
    const pad = Math.round(Math.min(source.width, source.height) * 6 / 100)
    const target = { width: source.width + pad * 2, height: source.height + pad * 2 }
    expect(target).toEqual({ width: 5910, height: 4086 })
    expect(target.width * target.height).toBeGreaterThan(16_000_000)

    const edge = defaultLongEdge(target)
    expect(edge).toBe(4810)
    const out = outputSize(target, edge)
    expect(out.width * out.height).toBeLessThanOrEqual(16_000_000)
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(8192)

    const next = outputSize(target, edge + 1)
    expect(next.width * next.height).toBeGreaterThan(16_000_000)
  })

  it('caps an over-long thin image at 8192', () => {
    expect(defaultLongEdge({ width: 8193, height: 1 })).toBe(8192)
  })
})

describe('cells / imageRect', () => {
  it('cover focus endpoints crop independently and contain preserves the whole image', () => {
    const cell = { id: 'a', x: 10, y: 20, width: 100, height: 100 }
    expect(imageRect({ width: 200, height: 100 }, cell, { x: 0, y: 50, fit: 'cover' })).toEqual({
      x: 10,
      y: 20,
      width: 200,
      height: 100,
    })
    expect(imageRect({ width: 200, height: 100 }, cell, { x: 100, y: 50, fit: 'cover' }).x).toBe(-90)
    expect(imageRect({ width: 200, height: 100 }, cell, { x: 50, y: 50, fit: 'contain' })).toEqual({
      x: 10,
      y: 45,
      width: 100,
      height: 50,
    })
  })

  it('rejects spacing that leaves no cell area', () => {
    expect(() => cells(collage({ width: 64, height: 64, assetIds: ['a', 'b'], padding: 40 }))).toThrow(
      /没有可用面积/,
    )
  })
})

describe('moveAsset / replaceAsset', () => {
  it('reorders and replaces while keeping an independent per-photo crop', () => {
    const a = collage({
      assetIds: ['a', 'b', 'c'],
      placements: {
        a: { x: 20, y: 80, fit: 'cover' },
        b: { x: 50, y: 50, fit: 'contain' },
      },
    })
    const moved = moveAsset(a, 'a', 1)
    expect(moved.assetIds).toEqual(['b', 'a', 'c'])
    expect(moved.placements).toEqual(a.placements)

    const replaced = replaceAsset(moved, 'a', 'new')
    expect(replaced.assetIds).toEqual(['b', 'new', 'c'])
    expect(replaced.placements.new).toEqual(a.placements.a)
    expect(replaced.placements.a).toBeUndefined()

    for (const mode of ['grid', 'row', 'column'] as const) {
      const d = { ...replaced, mode }
      expect(cells(d)).toHaveLength(3)
      expect(d.placements.new).toEqual(a.placements.a)
    }
  })
})
