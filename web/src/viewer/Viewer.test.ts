import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { Collection, Frame, Media, PhotoView, Tier } from '../api/types'
import Viewer from './Viewer.vue'
import { useTestRouter } from './testFixtures'

useTestRouter()

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
      top: '<template #top="p"><b class="t">{{ p.current }}/{{ p.frames }}/{{ p.atEnd }}</b></template>',
      left: '<i class="l" />',
      right: '<i class="r" />',
      bottom: '<i class="b" />',
      info: '<i class="info" />',
    })
    expect(v.find('.edge-top .t').text()).toBe('2/3/false')
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

  it('announces the end frame', async () => {
    const v = render(fullFrames(3), 3)
    key('ArrowDown')
    await nextTick()
    expect(v.find('[aria-live="polite"]').text()).toBe('结尾，共 3 帧。海边')
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
    await flushPromises()
    // Slow and below 20% of the viewport: springs back.
    expect(v.emitted('frame')).toBeUndefined()
    expect(v.find('.track').attributes('style')).toContain('calc(-100% + 0px)')
    expect(v.find('.track').classes()).not.toContain('dragging')
  })

  it.each([false, true])('keeps the transition off when a drag passes back through zero (rebound: %s)', async (rebound) => {
    let t = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => t)
    const mq = fakeMatchMedia({ 'prefers-reduced-motion': false })
    const v = render(fullFrames(3), 2)
    // A reduced-motion change rebinds the inputs, which reorders the window listeners.
    if (rebound) {
      mq.fire('prefers-reduced-motion', true)
      mq.fire('prefers-reduced-motion', false)
    }
    const stage = v.find('[role="region"]').element
    const ev = (type: string, y: number) =>
      new PointerEvent(type, { clientX: 100, clientY: y, pointerId: 1, isPrimary: true, button: 0, bubbles: true })
    stage.dispatchEvent(ev('pointerdown', 500))
    t += 300
    window.dispatchEvent(ev('pointermove', 470))
    t += 300
    window.dispatchEvent(ev('pointermove', 500))
    await nextTick()
    expect(v.find('.track').classes()).toContain('dragging')
    t += 300
    window.dispatchEvent(ev('pointermove', 480))
    t += 300
    window.dispatchEvent(ev('pointerup', 480))
    await flushPromises()
    expect(v.find('.track').classes()).not.toContain('dragging')
  })
})

function fakeMatchMedia(initial: Record<string, boolean>) {
  const lists = new Map<string, { matches: boolean; listeners: Set<() => void> }>()
  const get = (q: string) => {
    let l = lists.get(q)
    if (!l) {
      const key = Object.keys(initial).find((k) => q.includes(k))
      l = { matches: key ? initial[key]! : false, listeners: new Set() }
      lists.set(q, l)
    }
    return l
  }
  vi.stubGlobal('matchMedia', (q: string) => {
    const l = get(q)
    return {
      get matches() {
        return l.matches
      },
      media: q,
      addEventListener: (_: string, fn: () => void) => l.listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => l.listeners.delete(fn),
    }
  })
  return {
    fire(part: string, matches: boolean) {
      for (const [q, l] of lists) {
        if (!q.includes(part)) continue
        l.matches = matches
        l.listeners.forEach((fn) => fn())
      }
    },
  }
}

function pairFrames(): Frame[] {
  const frames = fullFrames(3)
  frames[1] = { layout: 'pair', matteRatio: null, text: null, photos: [photo('a'), photo('b')] }
  return frames
}

function sizeScroller(el: Element, scrollHeight: number, clientHeight = 768) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
}

describe('Viewer inner scroll', () => {
  it('follows the stacked media query change event', async () => {
    const mq = fakeMatchMedia({ 'orientation: portrait': false })
    const v = render(pairFrames(), 2)
    const pair = v.find('[data-frame="2"] .pair')
    sizeScroller(pair.element, 2000)
    expect(pair.classes()).not.toContain('stacked')
    mq.fire('orientation: portrait', true)
    await nextTick()
    expect(pair.classes()).toContain('stacked')
    key('ArrowDown')
    await nextTick()
    expect((pair.element as HTMLElement).scrollTop).toBeGreaterThan(0)
    expect(v.emitted('frame')).toBeUndefined()
    mq.fire('orientation: portrait', false)
    await nextTick()
    expect(pair.classes()).not.toContain('stacked')
    key('ArrowDown')
    await nextTick()
    expect(v.emitted('frame')).toEqual([[3]])
  })

  it('enters a stacked pair at the top going forward and at the bottom going back', async () => {
    fakeMatchMedia({ 'orientation: portrait': true })
    const v = render(pairFrames(), 3)
    const el = v.find('[data-frame="2"] .pair').element as HTMLElement
    sizeScroller(el, 2000)
    key('ArrowUp')
    await flushPromises()
    expect(v.emitted('frame')).toEqual([[2]])
    expect(el.scrollTop).toBe(1232)
    key('ArrowUp')
    await nextTick()
    expect(v.emitted('frame')).toEqual([[2]])
    expect(el.scrollTop).toBeLessThan(1232)
    key('Home')
    await flushPromises()
    key('ArrowDown')
    await flushPromises()
    expect(el.scrollTop).toBe(0)
  })

  it('scrolls a long text frame before paging', async () => {
    const frames = fullFrames(3)
    frames[1] = { layout: 'text', matteRatio: null, text: '长文'.repeat(400), photos: [] }
    const v = render(frames, 2)
    const el = v.find('[data-frame="2"] .text-wrap').element as HTMLElement
    sizeScroller(el, 1000)
    key('ArrowDown')
    await nextTick()
    expect(el.scrollTop).toBe(232)
    expect(v.emitted('frame')).toBeUndefined()
    key('ArrowDown')
    await nextTick()
    expect(v.emitted('frame')).toEqual([[3]])
  })

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

function deferDecode() {
  const pending: { src: string; resolve: () => void }[] = []
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (this: HTMLImageElement) {
    return new Promise<void>((resolve) => pending.push({ src: this.getAttribute('src') ?? '', resolve }))
  })
  return {
    resolve(id: string) {
      for (const p of pending.filter((p) => p.src.includes(`/m/${id}/`))) p.resolve()
    },
  }
}

describe('Viewer preload', () => {
  it('waits for the current image to decode', async () => {
    const d = deferDecode()
    render(fullFrames(12), 6)
    await flushPromises()
    expect(preloadSets()).toHaveLength(0)
    d.resolve('p6')
    await flushPromises()
    expect(preloadSets()).toHaveLength(2)
  })

  it('drops a stale decode after paging on', async () => {
    const d = deferDecode()
    render(fullFrames(12), 6)
    await flushPromises()
    key('ArrowDown')
    await flushPromises()
    d.resolve('p6')
    await flushPromises()
    expect(preloadSets()).toHaveLength(0)
    d.resolve('p7')
    await flushPromises()
    const sets = preloadSets()
    expect(sets).toHaveLength(2)
    expect(sets.some((s) => s.includes('/m/p6/'))).toBe(true)
    expect(sets.some((s) => s.includes('/m/p8/'))).toBe(true)
  })

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

describe('Viewer with default edges (Task 6)', () => {
  function mountWith(props: Record<string, unknown> = {}) {
    w = mount(Viewer, {
      props: { collection: collection(fullFrames(3)), neighbors: null, initialFrame: 1, mode: 'public', ...props },
      attachTo: document.body,
    })
    return w
  }

  it('Esc closes the menu, then the info layer, then exits', async () => {
    const v = mountWith()
    await v.get('button[aria-haspopup="menu"]').trigger('click')
    key('i')
    await nextTick()
    expect(v.find('[role="dialog"]').exists()).toBe(true)
    key('Escape')
    await nextTick()
    expect(v.get('button[aria-haspopup="menu"]').attributes('aria-expanded')).toBe('false')
    expect(v.find('[role="dialog"]').exists()).toBe(true)
    key('Escape')
    await nextTick()
    expect(v.find('[role="dialog"]').exists()).toBe(false)
    expect(v.emitted('exit')).toBeUndefined()
    key('Escape')
    expect(v.emitted('exit')).toHaveLength(1)
  })

  it('i toggles the info layer', async () => {
    const v = mountWith()
    key('i')
    await nextTick()
    expect(v.find('[role="dialog"]').exists()).toBe(true)
    key('i')
    await nextTick()
    expect(v.find('[role="dialog"]').exists()).toBe(false)
  })

  it('flashes the top edge and announces the author when arriving from another author', async () => {
    vi.useFakeTimers()
    try {
      const v = mountWith({ fromOwnerId: 'u0' })
      await nextTick()
      expect(v.find('.edge-top').classes()).toContain('shown')
      expect(v.find('[aria-live]').text()).toBe('阿树 的「海边」')
      vi.advanceTimersByTime(1500)
      await nextTick()
      expect(v.find('.edge-top').classes()).not.toContain('shown')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not flash for the same author', async () => {
    const v = mountWith({ fromOwnerId: 'u1' })
    await nextTick()
    expect(v.find('.edge-top').classes()).not.toContain('shown')
    expect(v.find('[aria-live]').text()).toBe('')
  })

  it('an inactive viewer ignores input and emits nothing', async () => {
    const v = mountWith()
    await v.setProps({ active: false })
    key('ArrowDown')
    key('ArrowRight')
    key('i')
    key('Escape')
    await nextTick()
    expect(v.emitted('frame')).toBeUndefined()
    expect(v.emitted('navigate')).toBeUndefined()
    expect(v.emitted('exit')).toBeUndefined()
    expect(v.find('[role="dialog"]').exists()).toBe(false)
    expect(v.find('[data-frame="1"]').attributes('aria-hidden')).toBeUndefined()
  })

  it('deactivate() stops input at once (the leaving instance of a transition)', async () => {
    const v = mountWith()
    ;(v.vm as unknown as { deactivate(): void }).deactivate()
    key('ArrowDown')
    await nextTick()
    expect(v.emitted('frame')).toBeUndefined()
  })

  it('a touch swipe up from the bottom edge pulls the drawer with the finger, then opens info', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    window.dispatchEvent(new Event('resize'))
    const v = mountWith()
    const stage = v.find('[role="region"]').element
    const ev = (type: string, y: number) =>
      new PointerEvent(type, { clientX: 200, clientY: y, pointerId: 3, pointerType: 'touch', isPrimary: true, bubbles: true })
    stage.dispatchEvent(ev('pointerdown', 790))
    window.dispatchEvent(ev('pointermove', 700))
    await nextTick()
    const d = v.get('[role="dialog"]')
    expect(d.classes()).toContain('drawer')
    expect((d.element as HTMLElement).style.transform).toContain('-90px')
    expect(v.find('.track').attributes('style')).toContain('+ 0px)')
    window.dispatchEvent(ev('pointermove', 550))
    window.dispatchEvent(ev('pointerup', 550))
    await flushPromises()
    expect(v.find('[role="dialog"]').exists()).toBe(true)
    expect((v.get('[role="dialog"]').element as HTMLElement).style.transform).toBe('')
    expect(v.emitted('frame')).toBeUndefined()
  })

  it('a short bottom-edge pull springs back and leaves info closed', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    window.dispatchEvent(new Event('resize'))
    const v = mountWith()
    const stage = v.find('[role="region"]').element
    const ev = (type: string, y: number) =>
      new PointerEvent(type, { clientX: 200, clientY: y, pointerId: 3, pointerType: 'touch', isPrimary: true, bubbles: true })
    stage.dispatchEvent(ev('pointerdown', 790))
    window.dispatchEvent(ev('pointermove', 720))
    window.dispatchEvent(ev('pointerup', 720))
    await flushPromises()
    expect(v.find('[role="dialog"]').exists()).toBe(false)
  })

  it('a horizontal drag reveals the neighbour covers at ±100%, only while dragging', async () => {
    const cover = (id: string): Media => media(id)
    const nb = {
      wall: 'square',
      prev: { id: 'p', title: '前', owner: { id: 'u1', name: '阿树' }, count: 2, cover: cover('prevc') },
      next: { id: 'n', title: '后', owner: { id: 'u2', name: '林' }, count: 2, cover: cover('nextc') },
      strip: [],
    }
    const v = mountWith({ neighbors: nb })
    expect(v.find('.peek').exists()).toBe(false)
    const stage = v.find('[role="region"]').element
    const ev = (type: string, x: number) =>
      new PointerEvent(type, { clientX: x, clientY: 300, pointerId: 4, pointerType: 'touch', isPrimary: true, bubbles: true })
    stage.dispatchEvent(ev('pointerdown', 300))
    window.dispatchEvent(ev('pointermove', 240))
    await nextTick()
    const next = v.get('.peek-next')
    const prev = v.get('.peek-prev')
    expect(next.attributes('style')).toContain('translate3d(calc(100% + -60px)')
    expect(prev.attributes('style')).toContain('translate3d(calc(-100% + -60px)')
    expect(next.get('img').attributes('src')).toBe('/m/nextc/w1280.jpg')
    expect(next.get('source[type="image/avif"]').attributes('srcset')).toContain('/m/nextc/w480.avif')
    expect(prev.get('img').attributes('src')).toBe('/m/prevc/w1280.jpg')
    window.dispatchEvent(ev('pointerup', 240))
    await flushPromises()
    expect(v.find('.peek').exists()).toBe(false)
  })

  it('no peek for a vertical drag or in preview mode', async () => {
    const nb = { wall: 'square', prev: null, next: { id: 'n', title: '后', owner: { id: 'u2', name: '林' }, count: 2, cover: media('nextc') }, strip: [] }
    const v = mountWith({ neighbors: nb, mode: 'preview' })
    const stage = v.find('[role="region"]').element
    const ev = (type: string, x: number, y = 300) =>
      new PointerEvent(type, { clientX: x, clientY: y, pointerId: 5, pointerType: 'touch', isPrimary: true, bubbles: true })
    stage.dispatchEvent(ev('pointerdown', 300))
    window.dispatchEvent(ev('pointermove', 240))
    await nextTick()
    expect(v.find('.peek').exists()).toBe(false)
    window.dispatchEvent(ev('pointerup', 240))
    await v.setProps({ mode: 'public' })
    stage.dispatchEvent(ev('pointerdown', 300, 300))
    window.dispatchEvent(ev('pointermove', 300, 240))
    await nextTick()
    expect(v.find('.peek').exists()).toBe(false)
    window.dispatchEvent(ev('pointerup', 300, 240))
  })

  it('renders the default end frame and its restart goes to frame 1', async () => {
    const v = mountWith({ initialFrame: 4 })
    const restart = v.findAll('[data-frame="4"] button').find((b) => b.text().includes('从头再看'))!
    await restart.trigger('click')
    expect(v.emitted('frame')).toEqual([[1]])
  })

  it('never emits jump or navigate from the end frame in preview mode', () => {
    const v = mountWith({ initialFrame: 4, mode: 'preview' })
    expect(v.find('[data-frame="4"]').text()).not.toContain('回到墙')
    expect(v.find('.edge-bottom button').exists()).toBe(false)
  })
})
