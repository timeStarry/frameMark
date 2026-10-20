import { describe, expect, it } from 'vitest'
import type { Exif } from '../api/types'
import { exifTable, formatAperture, formatBias, formatDate, formatFocal, formatShutter, paramLine } from './format'

describe('formatFocal', () => {
  it.each<[Exif, string | null]>([
    [{ focalLength: 35 }, '35mm'],
    [{ focalLength: 35, focalLength35mm: 52 }, '35mm (52mm)'],
    [{ focalLength: 35, focalLength35mm: 35 }, '35mm'],
    [{ focalLength: 4.25, focalLength35mm: 26 }, '4.3mm (26mm)'],
    [{ focalLength: 50.0 }, '50mm'],
    [{ focalLength35mm: 26 }, '等效 26mm'],
    [{}, null],
  ])('%j -> %s', (exif, want) => {
    expect(formatFocal(exif)).toBe(want)
  })
})

describe('formatAperture', () => {
  it.each<[number | undefined, string | null]>([
    [2, 'f/2'],
    [2.0, 'f/2'],
    [5.6, 'f/5.6'],
    [1.4, 'f/1.4'],
    [5.599999, 'f/5.6'],
    [11, 'f/11'],
    [undefined, null],
  ])('%s -> %s', (aperture, want) => {
    expect(formatAperture(aperture === undefined ? {} : { aperture })).toBe(want)
  })
})

describe('formatShutter', () => {
  it.each<[Exif, string | null]>([
    [{ shutter: '1/250' }, '1/250'],
    [{ shutter: '1/250', exposureSeconds: 0.004 }, '1/250'],
    [{ shutter: '2' }, '2"'],
    [{ shutter: '2.5' }, '2.5"'],
    [{ shutter: '3/10' }, '0.3"'],
    [{ exposureSeconds: 0.004 }, '1/250'],
    [{ exposureSeconds: 1 / 8000 }, '1/8000'],
    [{ exposureSeconds: 0.3 }, '0.3"'],
    [{ exposureSeconds: 2 }, '2"'],
    [{ exposureSeconds: 1 }, '1"'],
    [{ exposureSeconds: 30 }, '30"'],
    [{ exposureSeconds: 0 }, null],
    [{}, null],
  ])('%j -> %s', (exif, want) => {
    expect(formatShutter(exif)).toBe(want)
  })
})

describe('formatBias', () => {
  it.each<[number, string | null]>([
    [0.7, '+0.7 EV'],
    [2 / 3, '+0.7 EV'],
    [-1, '-1 EV'],
    [-1 / 3, '-0.3 EV'],
    [1, '+1 EV'],
    [0, null],
    [0.01, null],
  ])('%s -> %s', (exposureBias, want) => {
    expect(formatBias({ exposureBias })).toBe(want)
  })
})

describe('formatDate', () => {
  it('formats UTC milliseconds as YYYY.MM.DD', () => {
    expect(formatDate(Date.UTC(2024, 4, 3, 23, 59))).toBe('2024.05.03')
    expect(formatDate(Date.UTC(1999, 11, 31))).toBe('1999.12.31')
  })

  it('shifts by the EXIF offset to get the local taken date', () => {
    const ms = Date.UTC(2026, 4, 3, 17)
    expect(formatDate(ms, 480)).toBe('2026.05.04')
    expect(formatDate(ms)).toBe('2026.05.03')
    expect(formatDate(Date.UTC(2026, 4, 3, 2), -330)).toBe('2026.05.02')
  })
})

describe('paramLine', () => {
  it('orders focal, aperture, shutter, ISO, bias', () => {
    expect(
      paramLine({
        exposureBias: 0.7,
        iso: 200,
        shutter: '1/250',
        aperture: 2,
        focalLength: 35,
        focalLength35mm: 52,
        camera: 'X100V',
      }),
    ).toEqual(['35mm (52mm)', 'f/2', '1/250', 'ISO 200', '+0.7 EV'])
  })

  it('skips missing fields and zero bias', () => {
    expect(paramLine({ focalLength: 35, iso: 200, exposureBias: 0 })).toEqual(['35mm', 'ISO 200'])
  })

  it('is empty for null or empty exif', () => {
    expect(paramLine(null)).toEqual([])
    expect(paramLine({})).toEqual([])
    expect(paramLine({ camera: 'X100V', lens: 'L' })).toEqual([])
  })
})

describe('exifTable', () => {
  it('lists every public field with Chinese labels in order', () => {
    expect(
      exifTable({
        camera: 'FUJIFILM X100V',
        lens: '23mm F2',
        focalLength: 23,
        focalLength35mm: 35,
        aperture: 5.6,
        shutter: '1/250',
        iso: 160,
        exposureBias: -0.3,
        takenAt: Date.UTC(2024, 0, 9, 8),
      }),
    ).toEqual([
      { label: '机身', value: 'FUJIFILM X100V' },
      { label: '镜头', value: '23mm F2' },
      { label: '焦距', value: '23mm (35mm)' },
      { label: '光圈', value: 'f/5.6' },
      { label: '快门', value: '1/250' },
      { label: '感光度', value: 'ISO 160' },
      { label: '曝光补偿', value: '-0.3 EV' },
      { label: '拍摄日期', value: '2024.01.09' },
    ])
  })

  it('shows a zero bias in the table', () => {
    expect(exifTable({ exposureBias: 0 })).toEqual([{ label: '曝光补偿', value: '0 EV' }])
  })

  it('shows the taken date in the photo own time zone', () => {
    expect(exifTable({ takenAt: Date.UTC(2026, 4, 3, 17), takenOffsetMinutes: 480 })).toEqual([
      { label: '拍摄日期', value: '2026.05.04' },
    ])
  })

  it('is empty for null', () => {
    expect(exifTable(null)).toEqual([])
  })
})
