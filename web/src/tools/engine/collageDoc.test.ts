import { describe, expect, it } from 'vitest'
import { collageDefaults, defaultsCollage } from './collageDoc'
import { cells } from './geometry'

describe('collageDefaults', () => {
  it('is a square 2-column grid with no assets', () => {
    const d = collageDefaults()
    expect(d).toMatchObject({ kind: 'collage', mode: 'grid', columns: 2, width: 1080, height: 1080, assetIds: [] })
    expect(defaultsCollage).toBe(collageDefaults)
  })

  it('is accepted by the geometry functions', () => {
    const d = { ...collageDefaults(), assetIds: ['a', 'b'] }
    expect(cells(d)).toHaveLength(2)
  })
})
