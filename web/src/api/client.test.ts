import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCollection, getNeighbors, originalURL } from './client'

function mockFetch(impl: (input: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getCollection', () => {
  it('requests the collection with same-origin credentials and returns data', async () => {
    const body = { id: 'c1', title: 'T', frames: [] }
    const fn = mockFetch(async () => json(body))
    const ctl = new AbortController()
    const r = await getCollection('c1', ctl.signal)
    expect(r).toEqual({ ok: true, data: body })
    expect(fn).toHaveBeenCalledTimes(1)
    const [url, init] = fn.mock.calls[0]!
    expect(url).toBe('/api/collections/c1')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.signal).toBe(ctl.signal)
  })

  it('encodes the id', async () => {
    const fn = mockFetch(async () => json({}))
    await getCollection('a/b?c')
    expect(fn.mock.calls[0]![0]).toBe('/api/collections/a%2Fb%3Fc')
  })

  it.each([404, 500, 401])('returns ok:false with status %i', async (status) => {
    mockFetch(async () => json({ error: 'x' }, status))
    expect(await getCollection('c1')).toEqual({ ok: false, status })
  })

  it('maps network errors to status 0', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await getCollection('c1')).toEqual({ ok: false, status: 0 })
  })

  it('maps an aborted request to status -1', async () => {
    mockFetch(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    expect(await getCollection('c1')).toEqual({ ok: false, status: -1 })
  })

  it('maps an abort while reading the body to status -1', async () => {
    const ctl = new AbortController()
    mockFetch(async () => {
      const r = json({ id: 'c1' })
      r.json = async () => {
        ctl.abort()
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      return r
    })
    expect(await getCollection('c1', ctl.signal)).toEqual({ ok: false, status: -1 })
  })

  it('maps an unparsable body to status 0', async () => {
    mockFetch(async () => new Response('<html>', { status: 200 }))
    expect(await getCollection('c1')).toEqual({ ok: false, status: 0 })
  })
})

describe('getNeighbors', () => {
  it('passes the wall query parameter, encoded', async () => {
    const body = { wall: 'album:a1', prev: null, next: null, strip: [] }
    const fn = mockFetch(async () => json(body))
    const r = await getNeighbors('c1', 'album:a1')
    expect(r).toEqual({ ok: true, data: body })
    expect(fn.mock.calls[0]![0]).toBe('/api/collections/c1/neighbors?wall=album%3Aa1')
    expect(fn.mock.calls[0]![1]?.credentials).toBe('same-origin')
  })

  it('omits wall when null', async () => {
    const fn = mockFetch(async () => json({ wall: 'user', prev: null, next: null, strip: [] }))
    await getNeighbors('c1', null)
    expect(fn.mock.calls[0]![0]).toBe('/api/collections/c1/neighbors')
  })

  it('returns status on failure', async () => {
    mockFetch(async () => json({}, 404))
    expect(await getNeighbors('c1', 'square')).toEqual({ ok: false, status: 404 })
  })
})

describe('originalURL', () => {
  it('builds the download URL without fetching', () => {
    const fn = mockFetch(async () => json({}))
    expect(originalURL('p 1', 'c/1')).toBe('/api/photos/p%201/original?collection=c%2F1')
    expect(fn).not.toHaveBeenCalled()
  })
})
