import { afterEach, describe, expect, it, vi } from 'vitest'

const parse = vi.hoisted(() => vi.fn())
vi.mock('exifr', () => ({ default: { parse } }))

import { fields, mapExif, parseExif } from './exif'

describe('exif whitelist', () => {
  afterEach(() => {
    parse.mockReset()
  })

  it('labels the six camera fields and drops everything else', () => {
    expect(fields).toEqual({
      Model: '相机',
      LensModel: '镜头',
      FocalLength: '焦距',
      FNumber: '光圈',
      ExposureTime: '快门',
      ISO: 'ISO',
    })
    expect(
      mapExif({
        Model: 'X100',
        ISO: 200,
        GPSLatitude: 31.2,
        SerialNumber: 'hidden',
      }),
    ).toEqual({ Model: 'X100', ISO: '200' })
    expect(mapExif(undefined)).toEqual({})
  })

  it('calls exifr with the pick whitelist and gps:false', async () => {
    parse.mockResolvedValue({ Model: 'X', GPSLatitude: 1 })
    const file = new File([new Uint8Array([0xff, 0xd8])], 'a.jpg', { type: 'image/jpeg' })
    await expect(parseExif(file)).resolves.toEqual({ Model: 'X' })
    expect(parse).toHaveBeenCalledWith(file, { pick: Object.keys(fields), gps: false })
  })

  it('returns an empty map when metadata parsing fails', async () => {
    parse.mockRejectedValue(new Error('no exif'))
    await expect(parseExif(new File([], 'a.jpg', { type: 'image/jpeg' }))).resolves.toEqual({})
  })
})
