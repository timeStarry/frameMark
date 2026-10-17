import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, type Router } from 'vue-router'
import { createAppRouter } from '../router'
import Wall from './Wall.vue'
import WallNav from './WallNav.vue'
import WallStatus from './WallStatus.vue'
import { card } from '../viewer/testFixtures'
import type { Card } from '../api/types'

let router: Router
let w: VueWrapper | null = null
const originalWidth = window.innerWidth

beforeEach(async () => {
  router = createAppRouter(createMemoryHistory())
  await router.push('/')
  await router.isReady()
})
afterEach(() => {
  w?.unmount()
  w = null
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true, writable: true })
  document.body.innerHTML = ''
})

function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { value: px, configurable: true, writable: true })
}

const cards: Card[] = Array.from({ length: 6 }, (_, i) =>
  card(`c${i}`, `合集${i}`, '阿树', 'u1', i % 2 ? { cover: null } : {}),
)

function mountWall(props: Record<string, unknown> = {}) {
  w = mount(Wall, {
    props: { cards, wall: 'square', layout: 'salon', featuredIds: new Set<string>(), showOwner: true, ...props },
    global: { plugins: [router] },
    attachTo: document.body,
  })
  return w
}

const column = (el: Element) => (el as HTMLElement).style.gridColumn

describe('Wall salon', () => {
  it('renders cards in input order as direct children with columns 1..3 at 1440px', () => {
    setWidth(1440)
    const wr = mountWall()
    const ids = wr.findAll('.card').map((c) => c.attributes('data-card-id'))
    expect(ids).toEqual(cards.map((c) => c.id))
    const items = wr.findAll('.wall > .item')
    expect(items).toHaveLength(6)
    const cols = items.map((i) => Number(column(i.element).split('/')[0]))
    for (const c of cols) expect([1, 2, 3]).toContain(c)
    expect(new Set(cols).size).toBeGreaterThan(1)
    for (const i of items) expect((i.element as HTMLElement).style.gridRowEnd).toMatch(/^span \d+$/)
    expect(wr.find('.wall').attributes('style')).toContain('repeat(3, 1fr)')
  })

  it('uses a single column at 360px', () => {
    setWidth(360)
    const wr = mountWall()
    for (const i of wr.findAll('.wall > .item')) expect(column(i.element).split('/')[0]!.trim()).toBe('1')
  })

  it('gives featured cards the full column width', () => {
    setWidth(1440)
    const wr = mountWall({ featuredIds: new Set(['c2']) })
    const item = wr.find('.item:has([data-card-id="c2"])')
    expect((item.element as HTMLElement).style.width).toBe('100%')
    expect((item.element as HTMLElement).style.justifySelf).toBe('center')
  })

  it('recomputes columns on resize', async () => {
    setWidth(1440)
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      fn(0)
      return 1
    })
    const wr = mountWall()
    setWidth(360)
    window.dispatchEvent(new Event('resize'))
    await wr.vm.$nextTick()
    expect(wr.find('.wall').attributes('style')).toContain('repeat(1, 1fr)')
  })

  it('works without ResizeObserver', () => {
    setWidth(1440)
    vi.stubGlobal('ResizeObserver', undefined)
    expect(() => mountWall()).not.toThrow()
  })
})

describe('Wall grid', () => {
  it('uses the uniform grid class without inline placement', () => {
    setWidth(1440)
    const wr = mountWall({ layout: 'grid' })
    expect(wr.find('.wall').classes()).toContain('grid')
    for (const i of wr.findAll('.wall > .item')) {
      expect((i.element as HTMLElement).style.gridColumn).toBe('')
    }
    expect(wr.find('.cover').attributes('style')).toContain('aspect-ratio: 0.8')
  })
})

describe('WallNav', () => {
  it('links Markr, 工具 and 我的', () => {
    w = mount(WallNav, { global: { plugins: [router] } })
    expect(w.find('nav').attributes('aria-label')).toBe('站点')
    const links = w.findAll('a').map((a) => [a.text(), a.attributes('href')])
    expect(links).toEqual([['Markr', '/'], ['工具', '/tools'], ['我的', '/me']])
  })
})

describe('WallStatus', () => {
  it('loading shows a status line', () => {
    w = mount(WallStatus, { props: { state: 'loading' } })
    expect(w.find('[role="status"]').text()).toBe('载入中')
  })
  it('error shows the message and a retry button', async () => {
    w = mount(WallStatus, { props: { state: 'error' } })
    expect(w.text()).toContain('网络连接出了问题')
    await w.find('button').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
    expect(w.find('button').text()).toBe('重试')
  })
  it('idle renders nothing visible', () => {
    w = mount(WallStatus, { props: { state: 'idle' } })
    expect(w.text()).toBe('')
  })
})
