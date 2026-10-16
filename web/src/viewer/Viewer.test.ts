import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Collection, Frame, Media, PhotoView, Tier } from '../api/types'
import Viewer from './Viewer.vue'

function media(id: string): Media {
  const tiers = {} as Media['tiers']
  for (const t of ['w480', 'w1280', 'w2400', 'w3840'] as Tier[]) {
    tiers[t] = { avif: `/m/${id}/${t}.avif`, webp: `/m/${id}/${t}.webp`, jpeg: `/m/${id}/${t}.jpg` }
  }
  return { width: 6000, height: 4000, tiers }
}

function photo(id: string, over: Partial<PhotoView> = {}): PhotoView {
  return {
    id,
    title: `标题${id}`,
    caption: `图注${id}`,
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

function collection(frames: Frame[]): Collection {
  return {
    id: 'c1',
    title: '海边',
    intro: '',
    owner: { id: 'u1', name: '阿树' },
    license: null,
    aiDeclaration: null,
    originalDownload: false,
    cover: null,
    publishedAt: null,
    frames,
  }
}

function fullFrames(n: number): Frame[] {
  return Array.from({ length: n }, (_, i) => ({
    layout: 'full' as const,
    matteRatio: null,
    text: null,
    photos: [photo(`p${i + 1}`)],
  }))
}

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.head.querySelectorAll('link').forEach((l) => l.remove())
})

function render(frames: Frame[], initialFrame: number, mode: 'public' | 'preview' = 'public', slots = {}) {
  w = mount(Viewer, {
    props: { collection: collection(frames), neighbors: null, initialFrame, mode },
    slots,
    attachTo: document.body,
  })
  return w
}

function key(k: string, shiftKey = false) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }))
}

function preloadSets(): string[] {
  return [...document.head.querySelectorAll('link[rel="preload"]')].map((l) => l.getAttribute('imagesrcset') ?? '')
}

describe('Viewer stage', () => {
  it('is a labelled region with touch-action none', () => {
    const v = render(fullFrames(3), 1)
    const stage = v.find('[role="region"]')
    expect(stage.attributes('aria-roledescription')).toBe('合集观看')
    expect(stage.attributes('aria-label')).toBe('海边')
    expect(stage.attributes('style')).toContain('touch-action: none')
  })

  it('renders the frames plus an end-frame placeholder', () => {
    const v = render(fullFrames(3), 1)
    const slots = v.findAll('[data-frame]')
    expect(slots.map((s) => s.attributes('data-frame'))).toEqual(['1', '2', '3', '4'])
    expect(v.find('[data-frame="4"] .end-frame').exists()).toBe(true)
  })

  it('renders the end slot inside the end frame', () => {
    const v = render(fullFrames(2), 3, 'public', { end: '<p class="custom-end">完</p>' })
    expect(v.find('[data-frame="3"] .custom-end').exists()).toBe(true)
  })

  it('only frames within current ±2 render img', () => {
    const v = render(fullFrames(12), 6)
    const withImg = v
      .findAll('[data-frame]')
      .filter((s) => s.find('img').exists())
      .map((s) => Number(s.attributes('data-frame')))
    expect(withImg).toEqual([4, 5, 6, 7, 8])
    expect(v.findAll('img')).toHaveLength(5)
  })

  it('gives the first viewed frame high fetch priority', () => {
    const v = render(fullFrames(12), 6)
    expect(v.find('[data-frame="6"] img').attributes('fetchpriority')).toBe('high')
    expect(v.find('[data-frame="7"] img').attributes('fetchpriority')).toBeUndefined()
  })

  it('translates the track to the current frame and hides other frames', () => {
    const v = render(fullFrames(5), 3)
    expect(v.find('.track').attributes('style')).toContain('translate3d(0px, calc(-200% + 0px), 0)')
    expect(v.find('[data-frame="3"]').attributes('aria-hidden')).toBeUndefined()
    expect(v.find('[data-frame="2"]').attributes('aria-hidden')).toBe('true')
    expect(v.find('[data-frame="2"]').attributes('inert')).toBeDefined()
  })

  it('exposes slots for the four edges and the info layer', () => {
    const v = render(fullFrames(3), 2, 'public', {
      top: '<template #top="p"><b class="t">{{ p.current }}/{{ p.total }}</b></template>',
      left: '<i class="l" />',
      right: '<i class="r" />',
      bottom: '<i class="b" />',
      info: '<i class="info" />',
    })
    expect(v.find('.edge-top .t').text()).toBe('2/4')
    expect(v.find('.edge-left .l').exists()).toBe(true)
    expect(v.find('.edge-right .r').exists()).toBe(true)
    expect(v.find('.edge-bottom .b').exists()).toBe(true)
    expect(v.find('.info-layer .info').exists()).toBe(true)
  })
})

describe('Viewer navigation', () => {
  it('pages on keys, emits frame and announces it', async () => {
    const v = render(fullFrames(12), 6)
    const live = v.find('[aria-live="polite"]')
    expect(live.text()).toBe('')
    key('ArrowDown')
    await nextTick()
    expect(v.emitted('frame')).toEqual([[7]])
    expect(live.text()).toBe('第 7 帧，共 12 帧。标题p7')
    expect(v.find('[data-frame="9"] img').exists()).toBe(true)
    expect(v.find('[data-frame="4"] img').exists()).toBe(false)
  })

  it('announces the caption when there is no title, and text frames by text', async () => {
    const frames = fullFrames(3)
    frames[1]!.photos[0]!.title = ''
    frames[2] = { layout: 'text', matteRatio: null, text: '风停了', photos: [] }
    const v = render(frames, 1)
    key('ArrowDown')
    await nextTick()
    expect(v.find('[aria-live="polite"]').text()).toBe('第 2 帧，共 3 帧。图注p2')
    key('ArrowDown')
    await nextTick()
    expect(v.find('[aria-live="polite"]').text()).toBe('第 3 帧，共 3 帧。风停了')
  })

  it('clamps at the first frame', async () => {
    const v = render(fullFrames(3), 1)
    key('ArrowUp')
    await nextTick()
    expect(v.emitted('frame')).toBeUndefined()
  })

  it('Home and End jump to the ends of the sequence', async () => {
    const v = render(fullFrames(5), 3)
    key('End')
    await nextTick()
    key('Home')
    await nextTick()
    expect(v.emitted('frame')).toEqual([[6], [1]])
  })

  it('stepping forward on the end frame navigates to the next collection', async () => {
    const v = render(fullFrames(12), 13)
    key('ArrowDown')
    await nextTick()
    expect(v.emitted('navigate')).toEqual([[1]])
    expect(v.emitted('frame')).toBeUndefined()
  })

  it('preview mode never navigates', async () => {
    const v = render(fullFrames(12), 13, 'preview')
    key('ArrowDown')
    key('ArrowRight')
    await nextTick()
    expect(v.emitted('navigate')).toBeUndefined()
  })

  it('horizontal intents navigate between collections', async () => {
    const v = render(fullFrames(3), 2)
    key('ArrowRight')
    key('ArrowLeft')
    await nextTick()
    expect(v.emitted('navigate')).toEqual([[1], [-1]])
  })

  it('follows a vertical drag on the track without transition', async () => {
    let t = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => t)
    const v = render(fullFrames(3), 2)
    const stage = v.find('[role="region"]').element
    const ev = (type: string, y: number) =>
      new PointerEvent(type, { clientX: 100, clientY: y, pointerId: 1, isPrimary: true, button: 0, bubbles: true })
    stage.dispatchEvent(ev('pointerdown', 500))
    t += 400
    window.dispatchEvent(ev('pointermove', 470))
    t += 400
    window.dispatchEvent(ev('pointermove', 450))
    await nextTick()
    const style = v.find('.track').attributes('style')
    expect(style).toContain('calc(-100% + -50px)')
    expect(v.find('.track').classes()).toContain('dragging')
    t += 400
    window.dispatchEvent(ev('pointerup', 450))
    await nextTick()
    // Slow and below 20% of the viewport: springs back.
    expect(v.emitted('frame')).toBeUndefined()
    expect(v.find('.track').attributes('style')).toContain('calc(-100% + 0px)')
    expect(v.find('.track').classes()).not.toContain('dragging')
  })
})

describe('Viewer inner scroll', () => {
  it('scrolls a stacked pair before paging, only on narrow portrait', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('orientation: portrait'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    const frames = fullFrames(3)
    frames[1] = { layout: 'pair', matteRatio: null, text: null, photos: [photo('a'), photo('b')] }
    const v = render(frames, 2)
    const pair = v.find('[data-frame="2"] .pair')
    expect(pair.classes()).toContain('stacked')
    const el = pair.element as HTMLElement
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 768 })
    key('ArrowDown')
    await nextTick()
    expect(el.scrollTop).toBeGreaterThan(0)
    expect(v.emitted('frame')).toBeUndefined()
    key('ArrowDown')
    await nextTick()
    expect(el.scrollTop).toBe(1232)
    key('ArrowDown')
    await nextTick()
    expect(v.emitted('frame')).toEqual([[3]])
  })

  it('does not route through inner when the pair is not stacked', async () => {
    const frames = fullFrames(3)
    frames[1] = { layout: 'pair', matteRatio: null, text: null, photos: [photo('a'), photo('b')] }
    const v = render(frames, 2)
    key('ArrowDown')
    await nextTick()
    expect(v.emitted('frame')).toEqual([[3]])
  })
})

describe('Viewer preload', () => {
  it('preloads only the adjacent frames once the current image decodes', async () => {
    render(fullFrames(12), 6)
    await flushPromises()
    const sets = preloadSets()
    expect(sets).toHaveLength(2)
    expect(sets.some((s) => s.includes('/m/p5/'))).toBe(true)
    expect(sets.some((s) => s.includes('/m/p7/'))).toBe(true)
    for (const l of document.head.querySelectorAll('link[rel="preload"]')) {
      expect(l.getAttribute('as')).toBe('image')
      expect(l.getAttribute('type')).toBe('image/avif')
      expect(l.getAttribute('imagesizes')).toBe('100vw')
      expect(l.outerHTML).not.toContain('/original')
    }
  })

  it('moves the preload links with the current frame and removes them on unmount', async () => {
    const v = render(fullFrames(12), 6)
    await flushPromises()
    key('ArrowDown')
    await flushPromises()
    const sets = preloadSets()
    expect(sets).toHaveLength(2)
    expect(sets.some((s) => s.includes('/m/p6/'))).toBe(true)
    expect(sets.some((s) => s.includes('/m/p8/'))).toBe(true)
    expect(sets.some((s) => s.includes('/m/p5/'))).toBe(false)
    v.unmount()
    w = null
    expect(preloadSets()).toHaveLength(0)
  })

  it('skips frames without media', async () => {
    const frames = fullFrames(3)
    frames[0] = { layout: 'text', matteRatio: null, text: '序', photos: [] }
    frames[2]!.photos[0]!.media = null
    render(frames, 2)
    await flushPromises()
    expect(preloadSets()).toHaveLength(0)
  })
})
