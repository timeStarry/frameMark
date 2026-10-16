import { describe, expect, it } from 'vitest'
import type { Media, Tier } from '../api/types'
import { preloadURL, sizesFor, srcset, tierWidth } from './media'

function mk(width: number, height: number): Media {
  const tiers = {} as Media['tiers']
  for (const t of ['w480', 'w1280', 'w2400', 'w3840'] as Tier[]) {
    tiers[t] = { avif: `/m/p/h/${t}.avif`, webp: `/m/p/h/${t}.webp`, jpeg: `/m/p/h/${t}.jpg` }
  }
  return { width, height, tiers }
}

describe('tierWidth', () => {
  it.each<[number, number, Tier, number]>([
    [6000, 4000, 'w480', 480],
    [6000, 4000, 'w3840', 3840],
    [4000, 6000, 'w480', 320],
    [4000, 6000, 'w1280', 853],
    [1000, 800, 'w1280', 1000],
    [1000, 800, 'w480', 480],
    [800, 1000, 'w3840', 800],
  ])('%ix%i %s -> %i', (w, h, tier, want) => {
    expect(tierWidth(mk(w, h), tier)).toBe(want)
  })
})

describe('srcset', () => {
  it('lists every tier with its real width', () => {
    expect(srcset(mk(6000, 4000), 'avif')).toBe(
      '/m/p/h/w480.avif 480w, /m/p/h/w1280.avif 1280w, /m/p/h/w2400.avif 2400w, /m/p/h/w3840.avif 3840w',
    )
  })

  it('uses the .jpg URLs for jpeg and portrait widths', () => {
    expect(srcset(mk(4000, 6000), 'jpeg')).toBe(
      '/m/p/h/w480.jpg 320w, /m/p/h/w1280.jpg 853w, /m/p/h/w2400.jpg 1600w, /m/p/h/w3840.jpg 2560w',
    )
  })

  it('drops tiers that duplicate a smaller width for small originals', () => {
    expect(srcset(mk(1000, 800), 'webp')).toBe('/m/p/h/w480.webp 480w, /m/p/h/w1280.webp 1000w')
  })
})

describe('sizesFor', () => {
  it.each<[Parameters<typeof sizesFor>[0], number, string]>([
    ['full', 1, '100vw'],
    ['matted', 1, '100vw'],
    ['pair', 2, '(max-width: 599px) and (orientation: portrait) 100vw, 50vw'],
    ['pair', 3, '(max-width: 599px) and (orientation: portrait) 100vw, 34vw'],
    ['text', 0, '100vw'],
  ])('%s/%i -> %s', (layout, count, want) => {
    expect(sizesFor(layout, count)).toBe(want)
  })
})

describe('preloadURL', () => {
  const m = mk(6000, 4000)
  it.each<[number, number, string]>([
    [390, 1, '/m/p/h/w480.avif'],
    [480, 1, '/m/p/h/w480.avif'],
    [390, 3, '/m/p/h/w1280.avif'],
    [1440, 1, '/m/p/h/w2400.avif'],
    [1440, 2, '/m/p/h/w3840.avif'],
    [2560, 2, '/m/p/h/w3840.avif'],
  ])('viewport %i at dpr %i -> %s', (vw, dpr, want) => {
    expect(preloadURL(m, vw, dpr)).toBe(want)
  })

  it('uses real widths for portrait images', () => {
    // w1280 is only 853 wide for a 2:3 portrait, so 900 device px needs w2400.
    expect(preloadURL(mk(4000, 6000), 900, 1)).toBe('/m/p/h/w2400.avif')
  })

  it('falls back to the smallest tier at full resolution for small originals', () => {
    // w1280..w3840 are all 1000 wide; srcset lists only w1280, so preload that.
    expect(preloadURL(mk(1000, 800), 1440, 2)).toBe('/m/p/h/w1280.avif')
  })
})
