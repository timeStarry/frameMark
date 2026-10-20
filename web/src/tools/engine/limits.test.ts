import { describe, expect, it } from 'vitest'
import {
  LIMITS,
  createAssetId,
  validateOutput,
  validateWorkingSet,
} from './limits'

describe('LIMITS', () => {
  it('raises the source budget to 60 MiB / 60 MP and keeps the output cap', () => {
    expect(LIMITS.maxFileBytes).toBe(60 * 1024 * 1024)
    expect(LIMITS.maxSourcePixels).toBe(60_000_000)
    expect(LIMITS.maxOutputPixels).toBe(16_000_000)
    expect(LIMITS.maxEdge).toBe(8192)
    expect(LIMITS.maxAssets).toBe(12)
    expect(LIMITS.previewEdge).toBe(1600)
    expect(LIMITS.historySteps).toBe(50)
  })
})

describe('validateOutput', () => {
  it('rejects zero, nonfinite, excessive pixels and side length', () => {
    validateOutput({ width: 4000, height: 4000 })
    for (const s of [
      { width: 0, height: 100 },
      { width: Number.NaN, height: 1 },
      { width: 4001, height: 4000 },
      { width: 8193, height: 1 },
    ]) {
      expect(() => validateOutput(s)).toThrow(/1600 万像素|8192/)
    }
  })
})

describe('validateWorkingSet', () => {
  it('blocks excessive work while allowing a 12-asset preview', () => {
    expect(validateWorkingSet(40_000_000, 1_600_000, 12)).toBeLessThan(LIMITS.estimatedMemoryBytes)
    expect(() => validateWorkingSet(40_000_000, 16_000_000, 12)).toThrow(/256/)
  })
})

describe('createAssetId', () => {
  it('uses randomUUID when it works and falls back without treating the id as a credential', () => {
    expect(createAssetId({ randomUUID: () => 'native-id' })).toBe('native-id')
    const ids = new Set(Array.from({ length: 100 }, () => createAssetId({})))
    expect(ids.size).toBe(100)
    expect([...ids].every((id) => id.startsWith('local-'))).toBe(true)
    expect(
      createAssetId({
        randomUUID: () => {
          throw Error('not secure')
        },
        getRandomValues: (a: Uint8Array) => {
          a.fill(7)
          return a
        },
      }),
    ).toMatch(/07070707070707070707070707070707$/)
  })
})
