import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { card } from '../viewer/testFixtures'
import type { AlbumPage } from '../api/types'
import { cardIds, env, open, setup, teardown } from './wallTestUtils'

const album: AlbumPage = {
  id: 'a1',
  title: '海',
  intro: '一些海',
  owner: { id: 'u1', name: '阿树' },
  members: [card('c1', '一'), card('c2', '二')],
}

beforeEach(() => setup())
afterEach(() => teardown())

describe('AlbumRoute', () => {
  it('shows a missing page on 404', async () => {
    const { w } = await open('/a/nope')
    expect(w.text()).toContain('这组照片不存在或已不再公开')
    expect(w.findAll('a').some((a) => a.text() === '回首页' && a.attributes('href') === '/')).toBe(true)
    expect(w.find('h1').text()).toBe('这组照片不存在或已不再公开')
    expect(w.find('nav[aria-label="站点"]').exists()).toBe(true)
    expect(document.title).toBe('未找到 — Markr')
  })

  it('renders the title, intro, owner link and member wall', async () => {
    env.routes['/api/albums/a1'] = { status: 200, body: album }
    const { w } = await open('/a/a1')
    expect(w.find('h1').text()).toBe('海')
    expect(w.find('main').attributes('aria-labelledby')).toBe(w.find('h1').attributes('id'))
    expect(w.text()).toContain('一些海')
    expect(w.find('a[href="/u/u1"]').text()).toBe('阿树')
    expect(document.title).toBe('海 · 阿树 — Markr')
    expect(w.find('.wall').classes()).toContain('salon')
    expect(cardIds(w)).toEqual(['c1', 'c2'])
    expect(w.find('a[data-card-id="c1"]').attributes('href')).toBe('/c/c1?wall=album:a1')
  })
})
