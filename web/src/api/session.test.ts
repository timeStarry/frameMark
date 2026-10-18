import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearViewerCaches, login, logout, logoutAll, refresh, register, session, verify } from './session'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function mockFetch(impl: (input: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

function seed() {
  sessionStorage.setItem('markr:wallCache:square', '{}')
  sessionStorage.setItem('markr:lastViewed:user:u1', '{}')
  sessionStorage.setItem('other', 'keep')
}

function expectCleared() {
  expect(sessionStorage.getItem('markr:wallCache:square')).toBeNull()
  expect(sessionStorage.getItem('markr:lastViewed:user:u1')).toBeNull()
  expect(sessionStorage.getItem('other')).toBe('keep')
}

function expectKept() {
  expect(sessionStorage.getItem('markr:wallCache:square')).toBe('{}')
  expect(sessionStorage.getItem('markr:lastViewed:user:u1')).toBe('{}')
}

beforeEach(() => {
  sessionStorage.clear()
  const s = session as { user: string | null; csrfToken: string | null; ready: boolean }
  s.user = null
  s.csrfToken = 'tok-0'
  s.ready = false
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('refresh', () => {
  it('loads the session state', async () => {
    mockFetch(async () => json({ user: 'u1', csrfToken: 'tok-1', registrationOpen: true }))
    await refresh()
    expect(session).toEqual({ ready: true, user: 'u1', csrfToken: 'tok-1', registrationOpen: true })
    expect(sessionStorage.getItem('markr:identity')).toBe('u1')
  })

  it('clears the caches when the user differs from the stored identity', async () => {
    sessionStorage.setItem('markr:identity', 'u1')
    seed()
    mockFetch(async () => json({ user: 'u2', csrfToken: 't', registrationOpen: false }))
    await refresh()
    expectCleared()
    expect(sessionStorage.getItem('markr:identity')).toBe('u2')
  })

  it('treats a stored null marker as a value', async () => {
    sessionStorage.setItem('markr:identity', 'u1')
    seed()
    mockFetch(async () => json({ user: null, csrfToken: 't', registrationOpen: false }))
    await refresh()
    expectCleared()
    seed()
    await refresh()
    expectKept()
  })

  it('leaves the caches when the user is the same', async () => {
    sessionStorage.setItem('markr:identity', 'u1')
    seed()
    mockFetch(async () => json({ user: 'u1', csrfToken: 't', registrationOpen: false }))
    await refresh()
    expectKept()
  })

  it('clears the caches when no identity was stored yet', async () => {
    seed()
    mockFetch(async () => json({ user: null, csrfToken: 't', registrationOpen: false }))
    await refresh()
    expectCleared()
  })

  it('marks ready and keeps the old state on a network error', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    await refresh()
    expect(session.ready).toBe(true)
    expect(session.csrfToken).toBe('tok-0')
  })

  it('shares one request between concurrent calls', async () => {
    const fn = mockFetch(async () => json({ user: null, csrfToken: 't', registrationOpen: false }))
    await Promise.all([refresh(), refresh()])
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('login / verify / logout', () => {
  it('login sends only email and password and takes the new token', async () => {
    sessionStorage.setItem('markr:identity', 'u1')
    seed()
    const fn = mockFetch(async () => json({ user: 'u1', csrfToken: 'tok-new' }))
    const r = await login('a@example.com', 'pw')
    expect(r).toEqual({ ok: true, status: 200, data: { user: 'u1' } })
    const [url, init] = fn.mock.calls[0]!
    expect(url).toBe('/api/auth/login')
    expect(JSON.parse(init!.body as string)).toEqual({ email: 'a@example.com', password: 'pw' })
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('tok-0')
    expect(session.csrfToken).toBe('tok-new')
    expect(session.user).toBe('u1')
    // Same user as before, but login clears unconditionally.
    expectCleared()
    expect(sessionStorage.getItem('markr:identity')).toBe('u1')
  })

  it('a failed login changes nothing', async () => {
    seed()
    mockFetch(async () => json({ error: '邮箱或密码不对。' }, 401))
    const r = await login('a@example.com', 'pw')
    expect(r).toEqual({ ok: false, status: 401, message: '邮箱或密码不对。' })
    expect(session.csrfToken).toBe('tok-0')
    expectKept()
  })

  it('verify sends token and password, takes the session and clears', async () => {
    seed()
    const fn = mockFetch(async () => json({ user: 'u9', csrfToken: 'tok-v' }, 201))
    const r = await verify('vtok', 'pw')
    expect(r.ok && r.status).toBe(201)
    expect(JSON.parse(fn.mock.calls[0]![1]!.body as string)).toEqual({ token: 'vtok', password: 'pw' })
    expect(session.user).toBe('u9')
    expect(session.csrfToken).toBe('tok-v')
    expectCleared()
    expect(sessionStorage.getItem('markr:identity')).toBe('u9')
  })

  it('register sends only the email and leaves the caches', async () => {
    seed()
    const fn = mockFetch(async () => json({}, 202))
    const r = await register('a@example.com')
    expect(r.ok).toBe(true)
    expect(JSON.parse(fn.mock.calls[0]![1]!.body as string)).toEqual({ email: 'a@example.com' })
    expectKept()
  })

  it.each([
    ['logout', logout, '/api/auth/logout'],
    ['logoutAll', logoutAll, '/api/auth/logout-all'],
  ] as const)('%s clears the user and caches, then picks up a fresh token', async (_n, fnc, path) => {
    ;(session as { user: string | null }).user = 'u1'
    sessionStorage.setItem('markr:identity', 'u1')
    seed()
    const fn = mockFetch(async (url) => {
      if (url === '/api/auth/session') return json({ user: null, csrfToken: 'tok-anon', registrationOpen: false })
      return json({ user: null })
    })
    const r = await fnc()
    expect(r.ok).toBe(true)
    expect(fn.mock.calls[0]![0]).toBe(path)
    expect(session.user).toBeNull()
    expectCleared()
    expect(sessionStorage.getItem('markr:identity')).toBe('null')
    expect(session.csrfToken).toBe('tok-anon')
  })

  it('never stores the password or tokens', async () => {
    mockFetch(async () => json({ user: 'u1', csrfToken: 'tok-secret' }))
    await login('a@example.com', 'hunter2')
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)!
      const v = sessionStorage.getItem(k)!
      expect(v).not.toContain('hunter2')
      expect(v).not.toContain('tok-secret')
    }
  })
})

describe('stale refresh', () => {
  function deferredSession() {
    let resolve!: (r: Response) => void
    const pending = new Promise<Response>((r) => (resolve = r))
    return { pending, resolve }
  }

  it('a refresh that resolves after login does not overwrite the login', async () => {
    sessionStorage.setItem('markr:identity', 'null')
    const d = deferredSession()
    const fn = mockFetch(async (url) => {
      if (url === '/api/auth/session') return d.pending
      return json({ user: 'u1', csrfToken: 'tok-login' })
    })
    const stale = refresh()
    const r = await login('a@example.com', 'pw')
    expect(r.ok).toBe(true)
    seed()
    d.resolve(json({ user: null, csrfToken: 'tok-stale', registrationOpen: true }))
    await stale
    expect(session.user).toBe('u1')
    expect(session.csrfToken).toBe('tok-login')
    expect(session.ready).toBe(true)
    expectKept()
    expect(sessionStorage.getItem('markr:identity')).toBe('u1')
    expect(fn.mock.calls.filter((c) => c[0] === '/api/auth/session')).toHaveLength(1)
  })

  it('a refresh that resolves after logout does not restore the old user', async () => {
    ;(session as { user: string | null }).user = 'u1'
    sessionStorage.setItem('markr:identity', 'u1')
    let n = 0
    const d = deferredSession()
    mockFetch(async (url) => {
      if (url === '/api/auth/session') {
        n++
        return n === 1 ? d.pending : json({ user: null, csrfToken: 'tok-anon', registrationOpen: false })
      }
      return json({ user: null })
    })
    const stale = refresh()
    await logout()
    seed()
    d.resolve(json({ user: 'u1', csrfToken: 'tok-old', registrationOpen: false }))
    await stale
    expect(session.user).toBeNull()
    expect(session.csrfToken).toBe('tok-anon')
    expectKept()
    expect(sessionStorage.getItem('markr:identity')).toBe('null')
  })

  it('a refresh started after a login still applies', async () => {
    mockFetch(async (url) => {
      if (url === '/api/auth/session') return json({ user: 'u1', csrfToken: 'tok-fresh', registrationOpen: false })
      return json({ user: 'u1', csrfToken: 'tok-login' })
    })
    await login('a@example.com', 'pw')
    await refresh()
    expect(session.csrfToken).toBe('tok-fresh')
  })
})

describe('storage failures', () => {
  it('a throwing sessionStorage causes no throw', async () => {
    const boom = () => {
      throw new Error('blocked')
    }
    vi.stubGlobal('sessionStorage', {
      getItem: boom,
      setItem: boom,
      removeItem: boom,
      key: boom,
      clear: boom,
      get length(): number {
        throw new Error('blocked')
      },
    })
    expect(() => clearViewerCaches()).not.toThrow()
    vi.stubGlobal('fetch', vi.fn(async () => json({ user: 'u1', csrfToken: 't', registrationOpen: false })))
    await expect(refresh()).resolves.toBeUndefined()
    expect(session.user).toBe('u1')
    await expect(login('a@example.com', 'pw')).resolves.toMatchObject({ ok: true })
  })

  it('a sessionStorage getter that throws causes no throw', async () => {
    vi.spyOn(globalThis, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(() => clearViewerCaches()).not.toThrow()
  })
})
