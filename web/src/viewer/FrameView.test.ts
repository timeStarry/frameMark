import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Frame, Media, PhotoView, Tier } from '../api/types'
import FrameView from './FrameView.vue'

function media(id: string, width = 6000, height = 4000): Media {
  const tiers = {} as Media['tiers']
  for (const t of ['w480', 'w1280', 'w2400', 'w3840'] as Tier[]) {
    tiers[t] = { avif: `/m/${id}/${t}.avif`, webp: `/m/${id}/${t}.webp`, jpeg: `/m/${id}/${t}.jpg` }
  }
  return { width, height, tiers }
}

function photo(id: string, over: Partial<PhotoView> = {}): PhotoView {
  return {
    id,
    title: `标题${id}`,
    caption: '',
    width: 6000,
    height: 4000,
    media: media(id),
    exif: null,
    histogram: null,
    attribution: null,
    downloadable: false,
    ...over,
  }
}

function frame(layout: Frame['layout'], photos: PhotoView[], over: Partial<Frame> = {}): Frame {
  return { layout, matteRatio: null, text: null, photos, ...over }
}

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
})

function render(f: Frame, props: Record<string, unknown> = {}) {
  w = mount(FrameView, { props: { frame: f, live: true, priority: false, stacked: false, ...props } })
  return w
}

describe('FrameView layouts', () => {
  it('full renders one photo inside a fit box', () => {
    const v = render(frame('full', [photo('a')]))
    expect(v.find('.frame').classes()).toContain('layout-full')
    expect(v.findAll('.fit picture')).toHaveLength(1)
  })

  it('matted sizes its box by matteRatio', () => {
    const v = render(frame('matted', [photo('a')], { matteRatio: 0.7 }))
    const matte = v.find('.matte')
    expect(matte.exists()).toBe(true)
    expect(matte.attributes('style')).toContain('width: 70%')
    expect(matte.attributes('style')).toContain('height: 70%')
    expect(matte.findAll('picture')).toHaveLength(1)
  })

  it('matted falls back to 0.8 without a ratio', () => {
    const v = render(frame('matted', [photo('a')]))
    expect(v.find('.matte').attributes('style')).toContain('width: 80%')
  })

  it('pair lays out photos in a row, flex-grown by aspect ratio', () => {
    const v = render(frame('pair', [photo('a'), photo('b', { media: media('b', 4000, 6000) })]))
    const pair = v.find('.pair')
    expect(pair.classes()).not.toContain('stacked')
    const items = v.findAll('.pair-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.attributes('style')).toContain('flex-grow: 1.5')
    expect(items[1]!.attributes('style')).toMatch(/flex-grow: 0\.66/)
    expect(v.findAll('.pair-item picture')).toHaveLength(2)
  })

  it('pair stacks when the stacked prop is set', () => {
    const v = render(frame('pair', [photo('a'), photo('b')]), { stacked: true })
    expect(v.find('.pair').classes()).toContain('stacked')
  })

  it('text renders the text block', () => {
    const v = render(frame('text', [], { text: '第一行\n第二行' }))
    const t = v.find('.text')
    expect(t.exists()).toBe(true)
    expect(t.text()).toContain('第一行')
    expect(v.find('picture').exists()).toBe(false)
  })
})

describe('Photo', () => {
  it('emits avif, webp, jpeg sources in order with srcset and sizes', () => {
    const v = render(frame('full', [photo('a')]))
    const sources = v.findAll('picture source')
    expect(sources.map((s) => s.attributes('type'))).toEqual(['image/avif', 'image/webp', 'image/jpeg'])
    expect(sources[0]!.attributes('srcset')).toBe(
      '/m/a/w480.avif 480w, /m/a/w1280.avif 1280w, /m/a/w2400.avif 2400w, /m/a/w3840.avif 3840w',
    )
    expect(sources[2]!.attributes('srcset')).toContain('/m/a/w480.jpg 480w')
    expect(sources[0]!.attributes('sizes')).toBe('100vw')
  })

  it('pair sources use the pair sizes', () => {
    const v = render(frame('pair', [photo('a'), photo('b')]))
    expect(v.find('source').attributes('sizes')).toBe('(max-width: 599px) and (orientation: portrait) 100vw, 50vw')
  })

  it('img carries width, height, alt and async decoding', () => {
    const v = render(frame('full', [photo('a')]))
    const img = v.find('img')
    expect(img.attributes('width')).toBe('6000')
    expect(img.attributes('height')).toBe('4000')
    expect(img.attributes('alt')).toBe('标题a')
    expect(img.attributes('decoding')).toBe('async')
    expect(img.attributes('src')).toBe('/m/a/w1280.jpg')
  })

  it('alt falls back to 照片', () => {
    const v = render(frame('full', [photo('a', { title: '' })]))
    expect(v.find('img').attributes('alt')).toBe('照片')
  })

  it('priority frame loads eagerly with high fetch priority', () => {
    const v = render(frame('full', [photo('a')]), { priority: true })
    const img = v.find('img')
    expect(img.attributes('fetchpriority')).toBe('high')
    expect(img.attributes('loading')).toBe('eager')
  })

  it('other frames load lazily without a fetch priority', () => {
    const v = render(frame('full', [photo('a')]))
    const img = v.find('img')
    expect(img.attributes('fetchpriority')).toBeUndefined()
    expect(img.attributes('loading')).toBe('lazy')
  })

  it('shows the failure notice after an image error', async () => {
    const v = render(frame('full', [photo('a')]))
    await v.find('img').trigger('error')
    expect(v.find('img').exists()).toBe(false)
    expect(v.text()).toContain('图片暂时无法加载')
  })

  it('shows the failure notice when media is null', () => {
    const v = render(frame('full', [photo('a', { media: null })]))
    expect(v.find('picture').exists()).toBe(false)
    expect(v.text()).toContain('图片暂时无法加载')
  })

  it('outside the window renders ratio placeholders without img', () => {
    const v = render(frame('pair', [photo('a'), photo('b')]), { live: false })
    expect(v.find('img').exists()).toBe(false)
    const ph = v.findAll('.placeholder')
    expect(ph).toHaveLength(2)
    expect(ph[0]!.attributes('style')).toContain('aspect-ratio: 6000 / 4000')
  })
})

describe('inner scroll', () => {
  function sized(el: Element, scrollHeight: number, clientHeight: number) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
  }

  it('is unavailable unless the pair is stacked', () => {
    const v = render(frame('pair', [photo('a'), photo('b')]))
    const vm = v.vm as unknown as { canScrollInner(d: 1 | -1): boolean }
    sized(v.find('.pair').element, 2000, 800)
    expect(vm.canScrollInner(1)).toBe(false)
  })

  it('scrolls within range and returns the residual', () => {
    const v = render(frame('pair', [photo('a'), photo('b')]), { stacked: true })
    const vm = v.vm as unknown as { canScrollInner(d: 1 | -1): boolean; scrollInner(dy: number): number }
    const el = v.find('.pair').element as HTMLElement
    sized(el, 2000, 800)
    expect(vm.canScrollInner(-1)).toBe(false)
    expect(vm.canScrollInner(1)).toBe(true)
    expect(vm.scrollInner(1000)).toBe(0)
    expect(el.scrollTop).toBe(1000)
    expect(vm.scrollInner(500)).toBe(300)
    expect(el.scrollTop).toBe(1200)
    expect(vm.canScrollInner(1)).toBe(false)
    expect(vm.canScrollInner(-1)).toBe(true)
    expect(vm.scrollInner(-1500)).toBe(-300)
    expect(el.scrollTop).toBe(0)
  })
})
