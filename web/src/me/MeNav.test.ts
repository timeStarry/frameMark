import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, type Router } from 'vue-router'
import { createAppRouter } from '../router'
import { session } from '../api/session'
import MeNav from './MeNav.vue'
import MeLayout from './MeLayout.vue'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Writable = { user: string | null; csrfToken: string | null; ready: boolean; registrationOpen: boolean }
const s = session as Writable

let router: Router
let w: VueWrapper | null = null

beforeEach(async () => {
  sessionStorage.clear()
  s.user = 'u1'
  s.csrfToken = 't'
  s.ready = true
  router = createAppRouter(createMemoryHistory())
  await router.push('/me/collections')
  await router.isReady()
})

afterEach(() => {
  w?.unmount()
  w = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MeNav', () => {
  it('links the workspace pages and marks the active one', async () => {
    w = mount(MeNav, { global: { plugins: [router] } })
    const links = w.findAll('a').map((a) => [a.text(), a.attributes('href')])
    expect(links).toEqual([
      ['归档', '/me'],
      ['合集', '/me/collections'],
      ['偏好', '/me/settings'],
      ['我的主页', '/u/u1'],
    ])
    const current = w.findAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]!.text()).toBe('合集')
  })

  it('marks 归档 only on /me itself', async () => {
    await router.push('/me')
    w = mount(MeNav, { global: { plugins: [router] } })
    const current = w.findAll('[aria-current="page"]')
    expect(current.map((c) => c.text())).toEqual(['归档'])
  })

  it('logs out, clears the caches and goes home', async () => {
    sessionStorage.setItem('markr:wallCache:square', '{}')
    sessionStorage.setItem('markr:lastViewed:user:u1', '{}')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/auth/session' ? json({ user: null, csrfToken: 'anon', registrationOpen: false }) : json({}),
      ),
    )
    w = mount(MeNav, { global: { plugins: [router] } })
    await w.find('button').trigger('click')
    await flushPromises()
    expect(session.user).toBeNull()
    expect(sessionStorage.getItem('markr:wallCache:square')).toBeNull()
    expect(sessionStorage.getItem('markr:lastViewed:user:u1')).toBeNull()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/'))
  })

  it('shows the server message when logout fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: '登出失败。' }, 500)))
    w = mount(MeNav, { global: { plugins: [router] } })
    await w.find('button').trigger('click')
    await flushPromises()
    expect(w.find('[role="alert"]').text()).toBe('登出失败。')
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/me/collections'))
  })
})

describe('MeLayout', () => {
  it('renders the nav above the child page', async () => {
    w = mount(MeLayout, { global: { plugins: [router] } })
    await flushPromises()
    expect(w.find('nav[aria-label="站点"]').exists()).toBe(true)
    expect(w.find('nav[aria-label="工作区"]').exists()).toBe(true)
    const h1 = w.find('main h1')
    expect(h1.text()).toBe('我的合集')
    expect(w.find('main').attributes('aria-labelledby')).toBe(h1.attributes('id'))
  })
})
