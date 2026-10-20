import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, type Router } from 'vue-router'
import { createAppRouter } from '../router'
import WallCard from './WallCard.vue'
import { card, media } from '../viewer/testFixtures'
import type { Card } from '../api/types'

function stubHover(hover: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('hover: hover') ? hover : q.includes('hover: none') ? !hover : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

let router: Router
let w: VueWrapper | null = null

beforeEach(async () => {
  router = createAppRouter(createMemoryHistory())
  await router.push('/')
  await router.isReady()
})
afterEach(() => {
  w?.unmount()
  w = null
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function mountCard(c: Card = card('c1', '海边'), props: Record<string, unknown> = {}) {
  w = mount(WallCard, {
    props: { card: c, wall: 'square', showOwner: true, eager: false, high: false, aspect: null, ...props },
    global: { plugins: [router] },
    attachTo: document.body,
  })
  return w
}

function stubRect(el: Element, width = 300) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: 200, width, height: 200, x: 0, y: 0, toJSON() {} }) as DOMRect
}

const shownSrcset = (wr: VueWrapper) => wr.find('img').attributes('srcset') ?? ''

function pointer(type: string, init: { pointerType: string; clientX?: number }) {
  const e = new Event(type, { bubbles: type !== 'pointerenter' && type !== 'pointerleave', cancelable: true })
  Object.assign(e, { pointerType: init.pointerType, clientX: init.clientX ?? 0, offsetX: init.clientX ?? 0 })
  return e
}

describe('WallCard', () => {
  beforeEach(() => stubHover(true))

  it('renders href, data-card-id, accessible name and caption', () => {
    const wr = mountCard()
    const a = wr.find('a.card')
    expect(a.attributes('href')).toBe('/c/c1?wall=square')
    expect(a.attributes('data-card-id')).toBe('c1')
    expect(a.attributes('aria-label')).toBe('海边，阿树，4 张')
    expect(wr.find('.line').text().replace(/\s+/g, ' ')).toBe('海边 · 阿树 · 4 张')
  })

  it('omits the owner when showOwner is false', () => {
    const wr = mountCard(card('c1', '海边'), { showOwner: false })
    expect(wr.find('a.card').attributes('aria-label')).toBe('海边，4 张')
    expect(wr.find('.line').text().replace(/\s+/g, ' ')).toBe('海边 · 4 张')
  })

  it('click pushes the viewer route with fromWall state', async () => {
    const wr = mountCard()
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    wr.find('a.card').element.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    // The /c/:id component is lazy, so the navigation resolves after its import.
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/c/c1?wall=square'))
    const state = router.options.history.state as Record<string, unknown>
    expect(state.fromWall).toBe(true)
    expect(state.viewerDepth).toBe(0)
  })

  it('ctrl-click and cmd-click leave navigation to the browser', async () => {
    const wr = mountCard()
    const push = vi.spyOn(router, 'push')
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...mod })
      wr.find('a.card').element.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)
    }
    await flushPromises()
    expect(push).not.toHaveBeenCalled()
  })

  it('owner badges: 草稿 wins, then 仅链接 or 私密, in the caption and the accessible name', () => {
    const cases: [Partial<Card>, string | null][] = [
      [{ status: 'draft', visibility: 'public' }, '草稿'],
      [{ status: 'draft', visibility: 'private' }, '草稿'],
      [{ status: 'published', visibility: 'unlisted' }, '仅链接'],
      [{ status: 'published', visibility: 'private' }, '私密'],
      [{ status: 'published', visibility: 'public' }, null],
      [{}, null],
    ]
    for (const [over, badge] of cases) {
      w?.unmount()
      const wr = mountCard(card('c1', '海边', '阿树', 'u1', over))
      const a = wr.find('a.card')
      if (badge) {
        expect(wr.find('.line .badge').text()).toBe(badge)
        expect(a.attributes('aria-label')).toBe(`海边，阿树，4 张，${badge}`)
      } else {
        expect(wr.find('.badge').exists()).toBe(false)
        expect(a.attributes('aria-label')).toBe('海边，阿树，4 张')
      }
    }
  })

  it('mouse sweep shows the matching preview and restores the cover on leave', async () => {
    const wr = mountCard()
    const frame = wr.find('.frame').element
    stubRect(frame)
    expect(shownSrcset(wr)).toContain('cover-c1')
    frame.dispatchEvent(pointer('pointerenter', { pointerType: 'mouse' }))
    frame.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', clientX: 250 }))
    await wr.vm.$nextTick()
    expect(shownSrcset(wr)).toContain('p-c1-3')
    frame.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', clientX: 10 }))
    await wr.vm.$nextTick()
    expect(shownSrcset(wr)).toContain('p-c1-1')
    frame.dispatchEvent(pointer('pointerleave', { pointerType: 'mouse' }))
    await wr.vm.$nextTick()
    expect(shownSrcset(wr)).toContain('cover-c1')
  })

  it('does not render previews before the first pointerenter', async () => {
    const wr = mountCard()
    expect(wr.html()).not.toContain('p-c1-')
    wr.find('.frame').element.dispatchEvent(pointer('pointerenter', { pointerType: 'mouse' }))
    await wr.vm.$nextTick()
    expect(wr.html()).toContain('p-c1-')
  })

  it('touch pointers do not sweep', async () => {
    const wr = mountCard()
    const frame = wr.find('.frame').element
    stubRect(frame)
    frame.dispatchEvent(pointer('pointerenter', { pointerType: 'touch' }))
    frame.dispatchEvent(pointer('pointermove', { pointerType: 'touch', clientX: 250 }))
    await wr.vm.$nextTick()
    expect(shownSrcset(wr)).toContain('cover-c1')
  })

  it('no previews: sweeping changes nothing and does not throw', async () => {
    const wr = mountCard(card('c1', '海边', '阿树', 'u1', { previews: [] }))
    const frame = wr.find('.frame').element
    stubRect(frame)
    frame.dispatchEvent(pointer('pointerenter', { pointerType: 'mouse' }))
    frame.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', clientX: 250 }))
    await wr.vm.$nextTick()
    expect(shownSrcset(wr)).toContain('cover-c1')
  })

  it('hover devices show no touch dots', () => {
    const wr = mountCard()
    expect(wr.findAll('.dots i')).toHaveLength(0)
  })

  it('touch devices show min(count, 5) hidden dots', () => {
    stubHover(false)
    const wr = mountCard(card('c1', '海边', '阿树', 'u1', { count: 9 }))
    const dots = wr.find('.dots')
    expect(dots.attributes('aria-hidden')).toBe('true')
    expect(dots.findAll('i')).toHaveLength(5)
    w?.unmount()
    const wr2 = mountCard(card('c2', '山'))
    expect(wr2.findAll('.dots i')).toHaveLength(4)
  })

  it('works without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(() => mountCard()).not.toThrow()
  })

  it('cover: null renders the 3:2 placeholder and the caption', () => {
    const wr = mountCard(card('c1', '海边', '阿树', 'u1', { cover: null, previews: [] }))
    const cover = wr.find('.cover')
    expect(cover.classes()).toContain('failed')
    expect(cover.attributes('style')).toContain('aspect-ratio: 1.5')
    expect(wr.find('img').exists()).toBe(false)
    expect(wr.find('.line').text()).toContain('海边')
  })

  it('a broken image falls back to the placeholder', async () => {
    const wr = mountCard()
    await wr.find('img').trigger('error')
    expect(wr.find('.cover').classes()).toContain('failed')
    expect(wr.find('img').exists()).toBe(false)
  })

  it('aspect prop overrides the cover ratio', () => {
    const wr = mountCard(card('c1', '海边'), { aspect: 0.8 })
    expect(wr.find('.cover').attributes('style')).toContain('aspect-ratio: 0.8')
  })

  it('keeps the box at the cover ratio while sweeping onto a portrait preview', async () => {
    const c = card('c1', '海边', '阿树', 'u1', { cover: media('cover-c1', 6000, 4000), previews: [media('p-c1-1', 4000, 6000)] })
    const wr = mountCard(c)
    const frame = wr.find('.frame').element
    stubRect(frame)
    const before = wr.find('.frame > .cover').attributes('style')
    expect(before).toContain('aspect-ratio: 1.5')
    frame.dispatchEvent(pointer('pointerenter', { pointerType: 'mouse' }))
    frame.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', clientX: 100 }))
    await wr.vm.$nextTick()
    expect(wr.find('.frame > .cover img').attributes('srcset')).toContain('p-c1-1')
    expect(wr.find('.frame > .cover').attributes('style')).toBe(before)
  })

  it('a card without a cover keeps 3:2 while sweeping', async () => {
    const c = card('c1', '海边', '阿树', 'u1', { cover: null, previews: [media('p-c1-1', 4000, 6000)] })
    const wr = mountCard(c)
    const frame = wr.find('.frame').element
    stubRect(frame)
    frame.dispatchEvent(pointer('pointerenter', { pointerType: 'mouse' }))
    frame.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', clientX: 100 }))
    await wr.vm.$nextTick()
    expect(wr.find('.frame > .cover').attributes('style')).toContain('aspect-ratio: 1.5')
  })

  it('previews use only w480/w1280, and preload matches the shown preview exactly', async () => {
    const wr = mountCard(card('c1', '海边'), { sizes: '33vw' })
    const frame = wr.find('.frame').element
    stubRect(frame)
    frame.dispatchEvent(pointer('pointerenter', { pointerType: 'mouse' }))
    await wr.vm.$nextTick()
    const sig = (el: { attributes: (k: string) => string | undefined }) => `${el.attributes('srcset')}|${el.attributes('sizes')}`
    const preloadImgs = wr.findAll('.preload img')
    expect(preloadImgs).toHaveLength(3)
    const preloadSources = wr.findAll('.preload source')
    for (const el of [...preloadImgs, ...preloadSources]) {
      const ss = el.attributes('srcset') ?? ''
      expect(ss).toMatch(/w480/)
      expect(ss).not.toMatch(/w2400|w3840/)
    }
    frame.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', clientX: 250 }))
    await wr.vm.$nextTick()
    const shown = wr.find('.frame > .cover')
    expect(shown.find('img').attributes('srcset')).toContain('p-c1-3')
    const preload3 = wr.findAll('.preload .cover')[2]!
    expect(shown.findAll('source').map(sig)).toEqual(preload3.findAll('source').map(sig))
    expect(sig(shown.find('img'))).toBe(sig(preload3.find('img')))
    for (const el of shown.findAll('img, source')) expect(el.attributes('srcset')).not.toMatch(/w2400|w3840/)
  })

  it('the cover itself still offers every tier', () => {
    const wr = mountCard()
    expect(wr.find('.frame > .cover img').attributes('srcset')).toContain('w3840')
  })

  it('resets the sweep when the card changes', async () => {
    const wr = mountCard()
    const frame = wr.find('.frame').element
    stubRect(frame)
    frame.dispatchEvent(pointer('pointerenter', { pointerType: 'mouse' }))
    frame.dispatchEvent(pointer('pointermove', { pointerType: 'mouse', clientX: 250 }))
    await wr.vm.$nextTick()
    expect(shownSrcset(wr)).toContain('p-c1-3')
    await wr.setProps({ card: card('c2', '山') })
    expect(shownSrcset(wr)).toContain('cover-c2')
    expect(wr.find('.preload').exists()).toBe(false)
  })
})
