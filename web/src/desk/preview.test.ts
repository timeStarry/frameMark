import { describe, it, expect } from 'vitest'
import type { CollectionFields, Exif, Histogram } from '../api/types'
import { filterExif, toPreview, type PhotoDetail } from './preview'
import type { DeskFrame, Seq } from './sequence'

const fullExif: Required<Exif> = {
  camera: 'Leica M6',
  lens: 'Summicron 35',
  focalLength: 35,
  focalLength35mm: 35,
  aperture: 2,
  shutter: '1/250',
  exposureSeconds: 0.004,
  iso: 400,
  exposureBias: -0.3,
  takenAt: 1_700_000_000_000,
  takenOffsetMinutes: 480,
}

const hist: Histogram = [[1], [2], [3], [4]]

const fields: CollectionFields = {
  title: '海边',
  intro: '一个夏天',
  visibility: 'public',
  distribute: false,
  originalDownload: false,
  license: null,
  aiDeclaration: null,
  coverPhotoId: null,
}

function frame(id: string): DeskFrame {
  return { key: id, layout: 'full', matteRatio: null, text: null, photos: [{ id, title: id, media: null, width: 10, height: 10 }] }
}

function detail(o: Partial<PhotoDetail> = {}): PhotoDetail {
  return { title: 't', caption: 'c', exif: fullExif, histogram: hist, attribution: null, publicFields: [], histogramPublic: false, ...o }
}

describe('filterExif', () => {
  const cases: [string, Exif][] = [
    ['camera', { camera: 'Leica M6' }],
    ['lens', { lens: 'Summicron 35' }],
    ['focal_length', { focalLength: 35, focalLength35mm: 35 }],
    ['aperture', { aperture: 2 }],
    ['shutter', { shutter: '1/250', exposureSeconds: 0.004 }],
    ['iso', { iso: 400 }],
    ['exposure_bias', { exposureBias: -0.3 }],
    ['taken_date', { takenAt: 1_700_000_000_000, takenOffsetMinutes: 480 }],
  ]
  for (const [field, want] of cases) {
    it(`${field} reveals exactly ${Object.keys(want).join(' + ')}`, () => {
      expect(filterExif(fullExif, [field])).toEqual(want)
    })
  }

  it('keeps nothing for no fields, unknown fields or location', () => {
    expect(filterExif(fullExif, [])).toBeNull()
    expect(filterExif(fullExif, ['location', 'histogram', '__proto__', 'toString'])).toBeNull()
  })

  it('returns null for null exif and drops keys absent from the source', () => {
    expect(filterExif(null, ['camera'])).toBeNull()
    expect(filterExif({ iso: 100 }, ['camera', 'iso'])).toEqual({ iso: 100 })
  })
})

describe('toPreview', () => {
  const base = { id: 'c1', owner: { id: 'u1', name: '我' }, publishedAt: null }

  it('keeps the histogram only when histogramPublic', () => {
    const seq: Seq = [frame('p1'), frame('p2')]
    const c = toPreview(base, fields, seq, {
      p1: detail({ histogramPublic: true }),
      p2: detail({ histogramPublic: false }),
    })
    expect(c.frames[0]?.photos[0]?.histogram).toEqual(hist)
    expect(c.frames[1]?.photos[0]?.histogram).toBeNull()
  })

  it('filters each photo by its own publicFields and uses local fields', () => {
    const seq: Seq = [frame('p1'), frame('p2')]
    const c = toPreview(base, { ...fields, coverPhotoId: 'p2' }, seq, {
      p1: detail({ publicFields: ['iso'], caption: '浪' }),
      p2: detail({ publicFields: ['camera'] }),
    })
    expect(c.title).toBe('海边')
    expect(c.frames[0]?.photos[0]?.exif).toEqual({ iso: 400 })
    expect(c.frames[0]?.photos[0]?.caption).toBe('浪')
    expect(c.frames[1]?.photos[0]?.exif).toEqual({ camera: 'Leica M6' })
    expect(c.cover?.id).toBe('p2')
    expect(c).not.toHaveProperty('status')
    expect(c).not.toHaveProperty('visibility')
  })

  it('shows no exif or histogram for a photo with no details', () => {
    const c = toPreview(base, fields, [frame('p1')], {})
    expect(c.frames[0]?.photos[0]).toMatchObject({ exif: null, histogram: null })
    expect(c.cover?.id).toBe('p1')
  })

  it('sends text frames cleaned', () => {
    const seq: Seq = [{ key: 't', layout: 'text', matteRatio: null, text: '  你好 \r\n', photos: [] }]
    expect(toPreview(base, fields, seq, {}).frames[0]?.text).toBe('你好')
  })
})
