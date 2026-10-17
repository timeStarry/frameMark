import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { card, media } from '../viewer/testFixtures'
import type { UserWall } from '../api/types'
import { cardIds, close, deferred, env, focusedCardId, open, setup, teardown } from './wallTestUtils'

const wallData = (over: Partial<UserWall['profile']> = {}): UserWall => ({
  profile: { id: 'u1', name: '阿树', bio: '海边的人', wallLayout: 'grid', ...over },
  collections: [card('c1', '一'), card('c2', '二')],
  albums: [{ id: 'a1', title: '海', intro: '', count: 3, cover: media('cover-a1') }],
})

beforeEach(() => setup())
afterEach(() => teardown())

describe('UserRoute', () => {
  it('shows a missing page on 404', async () => {
    const { w } = await open('/u/nobody')
    expect(w.text()).toContain('这位摄影师不存在')
    expect(w.find('a[href="/"]').text()).toBe('回首页')
  })

  it('renders the profile, the wall in its layout and the albums', async () => {
    env.routes['/api/u/u1'] = { status: 200, body: wallData() }
    const { w } = await open('/u/u1')
    expect(w.find('h1').text()).toBe('阿树')
    expect(w.find('main').attributes('aria-labelledby')).toBe(w.find('h1').attributes('id'))
    expect(w.text()).toContain('海边的人')
    expect(document.title).toBe('阿树 — Markr')
    expect(w.find('.wall').classes()).toContain('grid')
    expect(cardIds(w)).toEqual(['c1', 'c2'])
    expect(w.find('a[data-card-id="c1"]').attributes('href')).toBe('/c/c1?wall=user:u1')
    // Owner omitted in captions.
    expect(w.find('a[data-card-id="c1"]').text()).not.toContain('阿树')
    expect(w.find('h2').text()).toBe('作品集')
    const album = w.find('a[href="/a/a1"]')
    expect(album.exists()).toBe(true)
    expect(album.text()).toContain('海 · 3 组')
  })

  it('omits the bio and albums when empty, and shows an empty wall message', async () => {
    env.routes['/api/u/u1'] = { status: 200, body: { ...wallData({ bio: '', wallLayout: 'salon' }), collections: [], albums: [] } }
    const { w } = await open('/u/u1')
    expect(w.find('.bio').exists()).toBe(false)
    expect(w.find('h2').exists()).toBe(false)
    expect(w.text()).toContain('还没有公开的照片')
  })

  it('shows a network error without cache, retry loads', async () => {
    env.routes['/api/u/u1'] = 'network'
    const { w } = await open('/u/u1')
    expect(w.text()).toContain('网络连接出了问题')
    env.routes['/api/u/u1'] = { status: 200, body: wallData() }
    await w.findAll('button').find((b) => b.text() === '重试')!.trigger('click')
    await flushPromises()
    expect(cardIds(w)).toEqual(['c1', 'c2'])
  })

  it('renders the cache first, restores focus once, then replaces with fresh data', async () => {
    env.routes['/api/u/u1'] = { status: 200, body: wallData() }
    const { router } = await open('/u/u1')
    await router.push('/tools')
    await flushPromises()
    expect(sessionStorage.getItem('markr:wallCache:user:u1')).not.toBeNull()
    close()

    sessionStorage.setItem('markr:lastViewed:user:u1', 'c2')
    const fresh = deferred<{ status: number; body?: unknown }>()
    env.routes['/api/u/u1'] = fresh.promise
    const { w } = await open('/u/u1')
    expect(cardIds(w)).toEqual(['c1', 'c2'])
    expect(focusedCardId()).toBe('c2')
    fresh.resolve({ status: 200, body: { ...wallData(), collections: [card('c3', '三'), card('c1', '一')] } })
    await flushPromises()
    expect(cardIds(w)).toEqual(['c3', 'c1'])
    expect(env.scrolled).toEqual(['c2'])
  })

  it('stays silent when the background refresh fails with a cache', async () => {
    env.routes['/api/u/u1'] = { status: 200, body: wallData() }
    const { router } = await open('/u/u1')
    await router.push('/tools')
    await flushPromises()
    close()
    env.routes['/api/u/u1'] = 'network'
    const { w } = await open('/u/u1')
    expect(cardIds(w)).toEqual(['c1', 'c2'])
    expect(w.text()).not.toContain('网络连接出了问题')
  })
})
