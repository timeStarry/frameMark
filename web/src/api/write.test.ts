import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { send } from './write'
import { session } from './session'

const CSRF = '会话校验失败，请刷新页面后重试。'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function mockFetch(impl: (input: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name)

beforeEach(() => {
  ;(session as { csrfToken: string | null }).csrfToken = 'tok-1'
})

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('send', () => {
  it('sends the CSRF token, JSON content type and serialized body', async () => {
    const fn = mockFetch(async () => json({ id: 'p1' }, 201))
    const r = await send<{ id: string }>('POST', '/api/x', { a: 1 })
    expect(r).toEqual({ ok: true, status: 201, data: { id: 'p1' } })
    const [url, init] = fn.mock.calls[0]!
    expect(url).toBe('/api/x')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect(header(init, 'X-CSRF-Token')).toBe('tok-1')
    expect(header(init, 'Content-Type')).toBe('application/json')
    expect(init?.body).toBe('{"a":1}')
  })

  it('sends no body or content type when body is omitted', async () => {
    const fn = mockFetch(async () => json({}))
    await send('DELETE', '/api/x')
    const init = fn.mock.calls[0]![1]
    expect(init?.body).toBeUndefined()
    expect(header(init, 'Content-Type')).toBeNull()
  })

  it('refreshes once on a CSRF 403 and retries with the new token', async () => {
    let writes = 0
    const fn = mockFetch(async (url) => {
      if (url === '/api/auth/session') return json({ user: null, csrfToken: 'tok-2', registrationOpen: false })
      writes++
      return writes === 1 ? json({ error: CSRF }, 403) : json({ done: true })
    })
    const r = await send('POST', '/api/x', {})
    expect(r).toEqual({ ok: true, status: 200, data: { done: true } })
    const calls = fn.mock.calls.map((c) => c[0])
    expect(calls).toEqual(['/api/x', '/api/auth/session', '/api/x'])
    expect(header(fn.mock.calls[2]![1], 'X-CSRF-Token')).toBe('tok-2')
  })

  it('returns a second CSRF 403 without retrying again', async () => {
    const fn = mockFetch(async (url) => {
      if (url === '/api/auth/session') return json({ user: null, csrfToken: 'tok-2', registrationOpen: false })
      return json({ error: CSRF }, 403)
    })
    const r = await send('POST', '/api/x', {})
    expect(r).toEqual({ ok: false, status: 403, message: CSRF })
    expect(fn.mock.calls.filter((c) => c[0] === '/api/x')).toHaveLength(2)
    expect(fn.mock.calls.filter((c) => c[0] === '/api/auth/session')).toHaveLength(1)
  })

  it('does not refresh on a non-CSRF 403', async () => {
    const fn = mockFetch(async () => json({ error: '来源校验失败。' }, 403))
    const r = await send('POST', '/api/x', {})
    expect(r).toEqual({ ok: false, status: 403, message: '来源校验失败。' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it.each([400, 404, 409, 413])('returns the server message for %i', async (status) => {
    mockFetch(async () => json({ error: '文件太大。' }, status))
    expect(await send('PUT', '/api/x', {})).toEqual({ ok: false, status, message: '文件太大。' })
  })

  it('carries extra error-body keys as body', async () => {
    mockFetch(async () => json({ error: '这个合集在别处被修改过。', updatedAt: 7 }, 409))
    expect(await send('PUT', '/api/x', {})).toEqual({
      ok: false,
      status: 409,
      message: '这个合集在别处被修改过。',
      body: { error: '这个合集在别处被修改过。', updatedAt: 7 },
    })
  })

  it('maps a network error to status 0', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await send('POST', '/api/x', {})).toEqual({ ok: false, status: 0, message: '网络连接出了问题' })
  })

  it('treats a 204 with no body as success', async () => {
    mockFetch(async () => new Response(null, { status: 204 }))
    expect(await send('DELETE', '/api/photos/p1')).toEqual({ ok: true, status: 204, data: undefined })
  })

  it('treats an empty 200 body as success', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    expect(await send('POST', '/api/x', {})).toEqual({ ok: true, status: 200, data: undefined })
  })

  it('treats a 200 with Content-Length 0 as success', async () => {
    mockFetch(async () => new Response('', { status: 200, headers: { 'Content-Length': '0' } }))
    expect(await send('POST', '/api/x', {})).toEqual({ ok: true, status: 200, data: undefined })
  })

  it('maps an unreadable success body to status 0', async () => {
    mockFetch(async () => new Response('not json', { status: 200 }))
    expect(await send('POST', '/api/x', {})).toEqual({ ok: false, status: 0, message: '网络连接出了问题' })
  })

  it('maps an aborted request to status -1', async () => {
    mockFetch(async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    const r = await send('POST', '/api/x', {})
    expect(r.ok).toBe(false)
    expect(r.status).toBe(-1)
  })
})
