import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { card } from '../viewer/testFixtures'
import type { SquarePage } from '../api/types'
import { cardIds, close, deferred, env, focusedCardId, open, setup, teardown } from './wallTestUtils'

const page1: SquarePage = {
  featured: [card('f1', '精选一'), card('c2', '二')],
  items: [card('c1', '一'), card('c2', '二'), card('c3', '三')],
  nextCursor: 'k1',
}
const page2: SquarePage = { featured: [], items: [card('c6', '六'), card('c7', '七')], nextCursor: null }

beforeEach(() => setup())
afterEach(() => teardown())

describe('SquareRoute', () => {
  it('renders featured first, then items without featured duplicates', async () => {
    env.routes['/api/square'] = { status: 200, body: page1 }
    const { w } = await open('/')
    expect(cardIds(w)).toEqual(['f1', 'c2', 'c1', 'c3'])
    expect(w.find('h1').text()).toBe('广场')
    expect(w.find('main').attributes('aria-labelledby')).toBe(w.find('h1').attributes('id'))
    expect(document.title).toBe('Markr')
    expect(w.find('a[data-card-id="c1"]').attributes('href')).toBe('/c/c1?wall=square')
  })

  it('loads the next page when the sentinel is visible, and appends', async () => {
    env.routes['/api/square'] = { status: 200, body: page1 }
    env.routes['/api/square?cursor=k1'] = { status: 200, body: page2 }
    const { w } = await open('/')
    const io = env.observers.at(-1)!
    expect(io.options?.rootMargin).toBe('800px 0px')
    io.fire()
    await flushPromises()
    expect(env.calls).toContain('/api/square?cursor=k1')
    expect(cardIds(w)).toEqual(['f1', 'c2', 'c1', 'c3', 'c6', 'c7'])
    // No next page: no more fetches, no load-more button.
    io.fire()
    await flushPromises()
    expect(env.calls.filter((c) => c.includes('cursor')).length).toBe(1)
    expect(w.text()).not.toContain('载入更多')
  })

  it('shows a retry when the next page fails, and retry loads it', async () => {
    env.routes['/api/square'] = { status: 200, body: page1 }
    env.routes['/api/square?cursor=k1'] = 'network'
    const { w } = await open('/')
    env.observers.at(-1)!.fire()
    await flushPromises()
    const retry = w.findAll('button').find((b) => b.text() === '重试')
    expect(retry).toBeTruthy()
    expect(cardIds(w)).toEqual(['f1', 'c2', 'c1', 'c3'])
    env.routes['/api/square?cursor=k1'] = { status: 200, body: page2 }
    await retry!.trigger('click')
    await flushPromises()
    expect(cardIds(w)).toEqual(['f1', 'c2', 'c1', 'c3', 'c6', 'c7'])
    expect(w.text()).not.toContain('重试')
  })

  it('falls back to a load-more button without IntersectionObserver', async () => {
    teardown()
    setup(false)
    // happy-dom may ship its own IntersectionObserver; remove it for this test.
    const g = globalThis as { IntersectionObserver?: unknown }
    const saved = g.IntersectionObserver
    delete g.IntersectionObserver
    try {
      env.routes['/api/square'] = { status: 200, body: page1 }
      env.routes['/api/square?cursor=k1'] = { status: 200, body: page2 }
      const { w } = await open('/')
      const btn = w.findAll('button').find((b) => b.text() === '载入更多')
      expect(btn).toBeTruthy()
      await btn!.trigger('click')
      await flushPromises()
      expect(cardIds(w)).toEqual(['f1', 'c2', 'c1', 'c3', 'c6', 'c7'])
    } finally {
      if (saved !== undefined) g.IntersectionObserver = saved
    }
  })

  it('saves the wall on leave, then restores from cache and refreshes in the background', async () => {
    env.routes['/api/square'] = { status: 200, body: page1 }
    env.routes['/api/square?cursor=k1'] = { status: 200, body: page2 }
    env.routes['/api/c/whatever'] = { status: 404 }
    const { router } = await open('/')
    env.observers.at(-1)!.fire()
    await flushPromises()
    await router.push('/tools')
    await flushPromises()
    expect(sessionStorage.getItem('markr:wallCache:square')).not.toBeNull()
    close()

    sessionStorage.setItem('markr:lastViewed:square', 'c7')
    const fresh = deferred<{ status: number; body?: unknown }>()
    env.routes['/api/square'] = fresh.promise
    const { w } = await open('/')
    // Cached render and restore happen before the fetch resolves.
    expect(cardIds(w)).toEqual(['f1', 'c2', 'c1', 'c3', 'c6', 'c7'])
    expect(focusedCardId()).toBe('c7')
    expect(env.scrolled).toEqual(['c7'])
    expect(sessionStorage.getItem('markr:lastViewed:square')).toBeNull()

    fresh.resolve({
      status: 200,
      body: { featured: [card('f9', '新精选')], items: [card('n1', '新'), card('c1', '一'), card('c2', '二')], nextCursor: 'zz' },
    })
    await flushPromises()
    await flushPromises()
    expect(cardIds(w)).toEqual(['f1', 'c2', 'n1', 'c1', 'c3', 'c6', 'c7'])
    expect(focusedCardId()).toBe('c7')
    expect(env.scrolled).toEqual(['c7'])
    // Cached nextCursor (null) is kept: no load-more.
    expect(w.text()).not.toContain('载入更多')
  })

  it('shows a network error on first load without a cache, and retry loads', async () => {
    env.routes['/api/square'] = 'network'
    const { w } = await open('/')
    expect(w.text()).toContain('网络连接出了问题')
    env.routes['/api/square'] = { status: 200, body: page1 }
    await w.findAll('button').find((b) => b.text() === '重试')!.trigger('click')
    await flushPromises()
    expect(cardIds(w)).toEqual(['f1', 'c2', 'c1', 'c3'])
    expect(w.text()).not.toContain('网络连接出了问题')
  })

  it('shows an empty message when the square has nothing', async () => {
    env.routes['/api/square'] = { status: 200, body: { featured: [], items: [], nextCursor: null } }
    const { w } = await open('/')
    expect(w.text()).toContain('还没有公开的照片')
  })

  it('scrolls to the top before restoring, so the restore wins', async () => {
    env.routes['/api/square'] = { status: 200, body: page1 }
    const { router } = await open('/')
    await router.push('/tools')
    await flushPromises()
    expect(sessionStorage.getItem('markr:wallCache:square')).not.toBeNull()
    sessionStorage.setItem('markr:lastViewed:square', 'c3')
    const order: string[] = []
    const spy = vi.spyOn(window, 'scrollTo').mockImplementation(() => void order.push('top'))
    const push = env.scrolled.push.bind(env.scrolled)
    env.scrolled.push = (...ids: string[]) => (order.push(...ids), push(...ids))
    try {
      await router.push('/')
      await flushPromises()
      await flushPromises()
      expect(order).toEqual(['top', 'c3'])
    } finally {
      spy.mockRestore()
    }
  })

  it('sets scrollRestoration to manual', async () => {
    history.scrollRestoration = 'auto'
    env.routes['/api/square'] = { status: 200, body: page1 }
    await open('/')
    expect(history.scrollRestoration).toBe('manual')
  })
})
