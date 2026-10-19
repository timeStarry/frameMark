import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, type Router } from 'vue-router'
import { createAppRouter } from '../router'
import { session } from '../api/session'
import CollectionsRoute from './CollectionsRoute.vue'
import { card, media } from '../viewer/testFixtures'
import type { UserWall } from '../api/types'
import { env, setup, teardown } from '../routes/wallTestUtils'

type Writable = { user: string | null; csrfToken: string | null; ready: boolean; registrationOpen: boolean }
const s = session as Writable

const wallData = (collections = [
  card('c3', '雾', '阿树', 'u1', { status: 'draft', visibility: 'private' }),
  card('c1', '海边', '阿树', 'u1', { status: 'published', visibility: 'public', count: 7 }),
  card('c2', '山', '阿树', 'u1', { status: 'published', visibility: 'unlisted' }),
  card('c4', '夜', '阿树', 'u1', { status: 'published', visibility: 'private', cover: null }),
]): UserWall => ({
  profile: { id: 'u1', name: '阿树', bio: '', wallLayout: 'grid' },
  collections,
  albums: [{ id: 'a1', title: '海', intro: '', count: 3, cover: media('cover-a1') }],
})

let router: Router
let w: VueWrapper | null = null

async function open() {
  router = createAppRouter(createMemoryHistory())
  await router.push('/')
  await router.isReady()
  w = mount(CollectionsRoute, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return w
}

const rows = (wr: VueWrapper) => wr.findAll('li a.row')

beforeEach(() => {
  setup(false)
  s.user = 'u1'
  s.ready = true
})
afterEach(() => {
  w?.unmount()
  w = null
  teardown()
  s.user = null
})

describe('CollectionsRoute', () => {
  it('has a labelled main, the h1 and the curation note', async () => {
    env.routes['/api/u/u1'] = { status: 200, body: wallData() }
    const wr = await open()
    const h1 = wr.find('h1')
    expect(h1.text()).toBe('我的合集')
    expect(wr.find('main').attributes('aria-labelledby')).toBe(h1.attributes('id'))
    expect(wr.text()).toContain('编排和发布在策展台中进行（即将推出）')
    expect(env.calls).toEqual(['/api/u/u1'])
    expect(document.title).toBe('我的合集 — Markr')
  })

  it('lists in wall order with title, count and status label', async () => {
    env.routes['/api/u/u1'] = { status: 200, body: wallData() }
    const wr = await open()
    const r = rows(wr)
    expect(r.map((a) => a.attributes('data-card-id'))).toEqual(['c3', 'c1', 'c2', 'c4'])
    expect(r.map((a) => a.find('.title').text())).toEqual(['雾', '海边', '山', '夜'])
    expect(r.map((a) => a.find('.count').text())).toEqual(['4 张', '7 张', '4 张', '4 张'])
    expect(r.map((a) => a.find('.status').text())).toEqual(['草稿', '公开', '仅链接', '私密'])
    // The list is not a wall.
    expect(wr.find('.wall').exists()).toBe(false)
    // 120px cover at 3:2, placeholder when the cover is missing.
    const cover = r[0]!.find('.cover')
    expect(cover.attributes('style')).toContain('aspect-ratio: 1.5')
    expect(r[3]!.find('.cover').classes()).toContain('failed')
  })

  it('links carry the user wall and the click pushes the wall state', async () => {
    env.routes['/api/u/u1'] = { status: 200, body: wallData() }
    const wr = await open()
    const a = rows(wr)[1]!
    expect(a.attributes('href')).toBe('/c/c1?wall=user:u1')
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    a.element.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/c/c1?wall=user:u1'))
    const state = router.options.history.state as Record<string, unknown>
    expect(state.fromWall).toBe(true)
    expect(state.viewerDepth).toBe(0)
  })

  it('cmd-click is left to the browser', async () => {
    env.routes['/api/u/u1'] = { status: 200, body: wallData() }
    const wr = await open()
    const push = vi.spyOn(router, 'push')
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true })
    rows(wr)[0]!.element.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(push).not.toHaveBeenCalled()
  })

  it('shows 还没有合集 when empty', async () => {
    env.routes['/api/u/u1'] = { status: 200, body: wallData([]) }
    const wr = await open()
    expect(wr.text()).toContain('还没有合集')
    expect(wr.find('ul').exists()).toBe(false)
  })

  it('shows a loading line, then a network error with retry', async () => {
    env.routes['/api/u/u1'] = 'network'
    const wr = await open()
    expect(wr.text()).toContain('网络连接出了问题')
    expect(wr.text()).not.toContain('还没有合集')
    env.routes['/api/u/u1'] = { status: 200, body: wallData() }
    await wr.findAll('button').find((b) => b.text() === '重试')!.trigger('click')
    expect(wr.text()).toContain('载入中')
    await flushPromises()
    expect(rows(wr)).toHaveLength(4)
    expect(wr.text()).not.toContain('网络连接出了问题')
  })

  it('reloads when the signed-in user changes', async () => {
    env.routes['/api/u/u1'] = { status: 200, body: wallData() }
    env.routes['/api/u/u2'] = { status: 200, body: wallData([card('c9', '别人', '某人', 'u2', { status: 'draft' })]) }
    const wr = await open()
    s.user = 'u2'
    await flushPromises()
    expect(rows(wr).map((a) => a.attributes('href'))).toEqual(['/c/c9?wall=user:u2'])
  })

  it('restores the document title on unmount', async () => {
    env.routes['/api/u/u1'] = { status: 200, body: wallData() }
    await open()
    w!.unmount()
    w = null
    expect(document.title).toBe('Markr')
  })
})
