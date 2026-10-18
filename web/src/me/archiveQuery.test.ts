import { describe, expect, it } from 'vitest'
import { fromRoute, isFiltered, toQuery } from './archiveQuery'
import type { ArchiveQuery } from '../api/types'

describe('archiveQuery', () => {
  it('round-trips every filter', () => {
    const q: ArchiveQuery = {
      year: 2025,
      camera: 'FUJIFILM X100V',
      lens: 'Fujinon 23mm',
      focalMin: 23,
      focalMax: 35.5,
      inCollection: false,
      status: 'failed',
    }
    const url = toQuery(q)
    expect(url).toEqual({
      year: '2025',
      camera: 'FUJIFILM X100V',
      lens: 'Fujinon 23mm',
      focal_min: '23',
      focal_max: '35.5',
      in_collection: 'false',
      status: 'failed',
    })
    expect(fromRoute(url)).toEqual(q)
    expect(fromRoute(toQuery({ inCollection: true, status: 'processing' }))).toEqual({ inCollection: true, status: 'processing' })
  })

  it('maps an empty query to no filters', () => {
    expect(fromRoute({})).toEqual({})
    expect(toQuery({})).toEqual({})
    expect(isFiltered({})).toBe(false)
    expect(isFiltered({ year: 2020 })).toBe(true)
  })

  it('ignores bad values', () => {
    expect(
      fromRoute({
        year: '20x5',
        camera: '',
        lens: ['a', 'b'],
        focal_min: '-3',
        focal_max: 'NaN',
        in_collection: 'yes',
        status: 'deleted',
        other: '1',
      }),
    ).toEqual({})
    expect(fromRoute({ year: '1899' })).toEqual({})
    expect(fromRoute({ year: '2101' })).toEqual({})
    expect(fromRoute({ year: '02020' })).toEqual({})
    expect(fromRoute({ camera: 'x'.repeat(201) })).toEqual({})
    expect(fromRoute({ focal_min: 'Infinity' })).toEqual({})
    expect(fromRoute({ focal_min: '0' })).toEqual({})
    expect(fromRoute({ year: null })).toEqual({})
  })

  it('drops an inverted focal range instead of sending a 400', () => {
    expect(fromRoute({ focal_min: '50', focal_max: '24' })).toEqual({})
    expect(fromRoute({ focal_min: '24', focal_max: '24' })).toEqual({ focalMin: 24, focalMax: 24 })
  })
})
