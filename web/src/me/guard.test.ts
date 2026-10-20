import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, type Router } from 'vue-router'
import { createAppRouter } from '../router'
import { session } from '../api/session'
import { safeNext } from './guard'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Writable = { user: string | null; csrfToken: string | null; ready: boolean; registrationOpen: boolean }
const s = session as Writable

describe('safeNext', () => {
  it('accepts in-site /me paths', () => {
    expect(safeNext('/me/settings')).toBe('/me/settings')
    expect(safeNext('/me')).toBe('/me')
    expect(safeNext('/me/collections?x=1')).toBe('/me/collections?x=1')
  })
  it('rejects dot segments, encoded or not, and undecodable paths', () => {
    for (const v of ['/me/../u/x', '/me/%2e%2e/u/x', '/me/%2E%2E/u/x', '/me/./settings', '/me/%', '/me/..', '/me/.?x=1']) {
      expect(safeNext(v)).toBe('/me')
    }
  })
  it('still passes clean paths with a query or hash', () => {
    for (const v of ['/me', '/me/settings?x=1', '/me/collections#top', '/me/settings?a=..', '/me/x#..']) {
      expect(safeNext(v)).toBe(v)
    }
  })
  it('falls back to /me for anything else', () => {
    for (const v of ['https://x', '//x', '/\\x', '/u/1', '/me//evil.com', '/me\\x', '', 'me', undefined, null, 3, ['/me/settings']]) {
      expect(safeNext(v)).toBe('/me')
    }
  })
})

describe('installGuard', () => {
  let router: Router
  let fetchFn: ReturnType<typeof vi.fn>

  function serve(user: string | null) {
    fetchFn = vi.fn(async (url: string) => {
      if (url === '/api/auth/session') return json({ user, csrfToken: 't', registrationOpen: true })
      return json({ user: 'u1', csrfToken: 't2' })
    })
    vi.stubGlobal('fetch', fetchFn)
  }

  beforeEach(() => {
    sessionStorage.clear()
    s.user = null
    s.csrfToken = null
    s.ready = false
    s.registrationOpen = false
    router = createAppRouter(createMemoryHistory())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('marks /me and its children requiresUser', () => {
    for (const p of ['/me', '/me/collections', '/me/settings']) {
      expect(router.resolve(p).meta.requiresUser).toBe(true)
    }
    expect(router.resolve('/me').name).toBe('archive')
    expect(router.resolve('/me/collections').name).toBe('me-collections')
    expect(router.resolve('/me/settings').name).toBe('me-settings')
    expect(router.resolve('/login').name).toBe('login')
  })

  it('awaits the session, then sends anonymous visitors to login with next', async () => {
    serve(null)
    await router.push('/me/settings?a=1')
    expect(fetchFn).toHaveBeenCalledWith('/api/auth/session', expect.anything())
    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.next).toBe('/me/settings?a=1')
  })

  it('lets a signed-in user through', async () => {
    serve('u1')
    await router.push('/me/collections')
    expect(router.currentRoute.value.name).toBe('me-collections')
  })

  it('does not refetch when the session is ready', async () => {
    serve('u1')
    s.ready = true
    s.user = 'u1'
    await router.push('/me')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(router.currentRoute.value.name).toBe('archive')
  })

  it('treats a network failure as anonymous', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await router.push('/me')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('sends a signed-in user away from login to a safe next', async () => {
    serve('u1')
    await router.push('/login?next=/me/settings')
    expect(router.currentRoute.value.fullPath).toBe('/me/settings')
    await router.push('/login?next=//evil.com')
    expect(router.currentRoute.value.fullPath).toBe('/me')
  })

  it('round-trips next: redirect, sign in, return', async () => {
    serve(null)
    await router.push('/me/settings')
    const next = router.currentRoute.value.query.next
    s.user = 'u1' // as login() would
    await router.replace(safeNext(next))
    expect(router.currentRoute.value.fullPath).toBe('/me/settings')
  })

  it('does not touch the session for public routes', async () => {
    serve(null)
    await router.push('/')
    expect(fetchFn).not.toHaveBeenCalledWith('/api/auth/session', expect.anything())
  })
})

describe('installGuard on a bare router', () => {
  it('registers the same rule', async () => {
    const { createRouter } = await import('vue-router')
    const { installGuard } = await import('./guard')
    s.ready = true
    s.user = null
    const r = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/login', name: 'login', component: { render: () => null } },
        { path: '/me', component: { render: () => null }, meta: { requiresUser: true } },
      ],
    })
    installGuard(r)
    await r.push('/me')
    expect(r.currentRoute.value.fullPath).toBe('/login?next=/me')
  })
})
