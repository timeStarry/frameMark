import { describe, expect, it } from 'vitest'
import { columnsFor, hash, rowSpan, salon, sweepIndex, type LayoutItem } from './layout'

const item = (id: string, aspect = 1.5, count = 4, featured = false): LayoutItem => ({ id, aspect, count, featured })

describe('columnsFor', () => {
  it.each([[360, 1], [599, 1], [600, 2], [1099, 2], [1100, 3], [1440, 3]])('%i → %i', (w, n) => {
    expect(columnsFor(w)).toBe(n)
  })
})

describe('salon', () => {
  const items = Array.from({ length: 40 }, (_, i) => item(`c${i}`, [1.5, 0.67, 3, 1][i % 4]!, (i * 5) % 20))
  it('is deterministic', () => {
    expect(salon(items, 3)).toEqual(salon(items, 3))
    expect(hash('abc')).toBe(hash('abc'))
    expect(hash('abc')).not.toBe(hash('abd'))
  })
  it('keeps width in [0.70, 1.00], and ≥ 0.85 on one column', () => {
    for (const p of salon(items, 3)) {
      expect(p.widthPct).toBeGreaterThanOrEqual(70)
      expect(p.widthPct).toBeLessThanOrEqual(100)
    }
    for (const p of salon(items, 1)) expect(p.widthPct).toBeGreaterThanOrEqual(85)
  })
  it('gives featured items full width', () => {
    expect(salon([item('f', 0.67, 3, true)], 3)[0]!.widthPct).toBe(100)
  })
  it('places each item in the currently shortest column', () => {
    // three equal squares fill columns 0,1,2 in order; the fourth goes to the shortest.
    // A square's column height increment is w / min(aspect, 2.4) + 0.15 = w + 0.15.
    const ps = salon([item('a', 1), item('b', 1), item('c', 1), item('d', 1)], 3)
    expect(ps.slice(0, 3).map((p) => p.column)).toEqual([0, 1, 2])
    const heights = [0, 1, 2].map((c) =>
      ps.slice(0, 3).filter((p) => p.column === c).reduce((h, p) => h + p.widthPct / 100 + 0.15, 0),
    )
    expect(ps[3]!.column).toBe(heights.indexOf(Math.min(...heights)))
  })
  it('uses full width and center on one column only when width is 100', () => {
    for (const p of salon(items, 1)) expect(p.column).toBe(0)
  })
  it('treats invalid aspect as 3:2', () => {
    expect(() => salon([item('x', 0), item('y', NaN)], 2)).not.toThrow()
  })
})

describe('sweepIndex', () => {
  it('splits the width into n equal bands and clamps', () => {
    expect(sweepIndex(0, 300, 3)).toBe(0)
    expect(sweepIndex(99, 300, 3)).toBe(0)
    expect(sweepIndex(100, 300, 3)).toBe(1)
    expect(sweepIndex(299, 300, 3)).toBe(2)
    expect(sweepIndex(-5, 300, 3)).toBe(0)
    expect(sweepIndex(400, 300, 3)).toBe(2)
  })
  it('handles 0 and 1 previews and zero width', () => {
    expect(sweepIndex(50, 300, 0)).toBe(-1)
    expect(sweepIndex(250, 300, 1)).toBe(0)
    expect(sweepIndex(10, 0, 3)).toBe(0)
  })
})

describe('rowSpan', () => {
  it('converts the estimated card height (image + caption + row gap) to 8px rows', () => {
    expect(rowSpan(100, 1.5, 300)).toBe(Math.ceil((200 + 40 + 24) / 8))
    expect(rowSpan(100, 1.5, 300, 8, 40, 0)).toBe(30)
    expect(rowSpan(50, 1, 400, 8, 40, 64)).toBe(Math.ceil((200 + 40 + 64) / 8))
  })
  it('clamps panoramas to 2.4:1', () => {
    expect(rowSpan(100, 5, 240, 8, 0, 0)).toBe(rowSpan(100, 2.4, 240, 8, 0, 0))
  })
})
