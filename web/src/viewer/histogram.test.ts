import { describe, expect, it } from 'vitest'
import { toPath } from './histogram'

describe('toPath', () => {
  it('builds a closed area normalised to the peak', () => {
    expect(toPath([0, 5, 10], 100, 50)).toBe('M0 50L0 50L50 25L100 0L100 50Z')
  })

  it('stays on the baseline when every bin is zero', () => {
    expect(toPath([0, 0], 10, 20)).toBe('M0 20L0 20L10 20L10 20Z')
  })

  it('rounds coordinates to two decimals', () => {
    expect(toPath([1, 3, 2], 10, 10)).toBe('M0 10L0 6.67L5 0L10 3.33L10 10Z')
  })

  it('handles a single bin', () => {
    expect(toPath([4], 10, 10)).toBe('M0 10L0 0L10 0L10 10Z')
  })

  it('returns an empty path for no bins', () => {
    expect(toPath([], 10, 10)).toBe('')
  })

  it('covers 64 bins across the full width', () => {
    const bins = Array.from({ length: 64 }, (_, i) => i)
    const d = toPath(bins, 630, 100)
    expect(d.startsWith('M0 100L0 100L10 98.41')).toBe(true)
    expect(d.endsWith('L630 0L630 100Z')).toBe(true)
  })
})
