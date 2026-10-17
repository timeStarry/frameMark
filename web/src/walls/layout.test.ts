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
  it('centers a featured item at full width on 1 and 3 columns', () => {
    for (const cols of [1, 3]) {
      const [p] = salon([item('f', 0.67, 3, true)], cols)
      expect(p!.widthPct).toBe(100)
      expect(p!.align).toBe('center')
    }
  })
  it('takes align from the hash when width is under 100', () => {
    const ALIGNS = ['start', 'center', 'end']
    for (const cols of [1, 3]) {
      const ps = salon(items, cols)
      const narrow = ps.filter((p) => p.widthPct < 100)
      expect(narrow.length).toBeGreaterThan(0)
      ps.forEach((p, i) => {
        expect(ALIGNS).toContain(p.align)
        if (p.widthPct < 100) expect(p.align).toBe(ALIGNS[(hash(items[i]!.id) >>> 10) % 3])
      })
      // more than one align among narrow items, so center is not forced by width
      expect(new Set(narrow.map((p) => p.align)).size).toBeGreaterThan(1)
    }
  })
  it('always centers items at width 100', () => {
    const mixed = [...items, item('f1', 1.5, 4, true), item('f2', 3, 20, true)]
    for (const cols of [1, 2, 3]) {
      const full = salon(mixed, cols).filter((p) => p.widthPct === 100)
      expect(full.length).toBeGreaterThan(0)
      for (const p of full) expect(p.align).toBe('center')
    }
  })
  // Number.isFinite rejects Infinity, so it is treated as invalid like 0, NaN and -1
  // (falls back to 3:2) rather than as a panorama.
  it.each([0, NaN, -1, Infinity])('treats aspect %s as 3:2, including the column height it adds', (bad) => {
    const run = (a: number) => salon([item('x', a), item('ref', 1.5), item('next', 1.5), item('last', 1)], 2)
    const got = run(bad)
    const want = run(1.5)
    expect(got[0]).toEqual(want[0])
    expect(got.slice(1)).toEqual(want.slice(1))
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
