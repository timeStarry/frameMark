import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectionCache } from './collectionCache'
import { login, logout, refresh, session } from '../api/session'
import { collection, fullFrame, photo } from '../viewer/testFixtures'
import type { Collection } from '../api/types'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const col = (id: string): Collection => collection([fullFrame(photo(`${id}p1`))], { id, title: id, owner: { id: 'u1', name: '阿树' } })

/** Routes the session endpoints; anything else is answered by `other`. */
function serve(sessionUser: () => string | null, other: (url: string) => Promise<Response> = async () => json({}, 404)) {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/api/auth/session') return json({ user: sessionUser(), csrfToken: 't', registrationOpen: false })
    if (url === '/api/auth/login') return json({ user: 'u1', csrfToken: 't1' })
    if (url === '/api/auth/logout') return json({})
    return other(url)
  })
}

beforeEach(() => {
  sessionStorage.clear()
  collectionCache.clear()
  const s = session as { user: string | null; csrfToken: string | null }
  s.user = null
  s.csrfToken = 'tok-0'
})

afterEach(() => {
  vi.unstubAllGlobals()
  collectionCache.clear()
  sessionStorage.clear()
})

describe('collectionCache and identity', () => {
  it('logout empties the cache', async () => {
    let user: string | null = 'u1'
    serve(() => user)
    await login('a@example.com', 'pw')
    collectionCache.put(col('priv'))
    user = null
    await logout()
    expect(collectionCache.get('priv')).toBeUndefined()
  })

  it('login empties the cache', async () => {
    serve(() => null)
    collectionCache.put(col('pub'))
    await login('a@example.com', 'pw')
    expect(collectionCache.get('pub')).toBeUndefined()
  })

  it('a different user on refresh empties the cache', async () => {
    let user = 'u1'
    serve(() => user)
    await refresh()
    collectionCache.put(col('priv'))
    user = 'u2'
    await refresh()
    expect(collectionCache.get('priv')).toBeUndefined()
  })

  it('the same user on refresh keeps the cache', async () => {
    serve(() => 'u1')
    await refresh()
    collectionCache.put(col('priv'))
    await refresh()
    expect(collectionCache.get('priv')?.id).toBe('priv')
  })

  it('a prefetch started before logout and resolved after does not populate the cache', async () => {
    let user: string | null = 'u1'
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    serve(
      () => user,
      async (url) => {
        await gate
        return url === '/api/collections/priv' ? json(col('priv')) : json({}, 404)
      },
    )
    await login('a@example.com', 'pw')
    const p = collectionCache.prefetch('priv')
    user = null
    await logout()
    release()
    await p
    expect(collectionCache.get('priv')).toBeUndefined()
  })
})
