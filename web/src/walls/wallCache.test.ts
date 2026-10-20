import { afterEach, describe, expect, it, vi } from 'vitest'
import { load, save, TTL_MS } from './wallCache'

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('wallCache', () => {
  it('returns saved data', () => {
    save('square', { ids: ['c1'] }, 1000)
    expect(load('square', 1000 + 5)).toEqual({ ids: ['c1'] })
  })

  it('expires after TTL_MS and removes the key', () => {
    save('square', [1], 1000)
    expect(load('square', 1000 + TTL_MS)).toEqual([1])
    expect(load('square', 1000 + TTL_MS + 1)).toBeNull()
    expect(sessionStorage.getItem('markr:wallCache:square')).toBeNull()
  })

  it('returns null for corrupt JSON', () => {
    sessionStorage.setItem('markr:wallCache:square', '{')
    expect(load('square')).toBeNull()
  })

  it('returns null when nothing is stored', () => {
    expect(load('album:a1')).toBeNull()
  })

  it('does not throw when setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => save('square', [1])).not.toThrow()
  })

  it('drops the older snapshot when a save fails, so it is never restored', () => {
    save('square', { pages: 1 }, 1000)
    // happy-dom's sessionStorage does not go through Storage.prototype.setItem.
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    save('square', { pages: 9 }, 2000)
    vi.restoreAllMocks()
    expect(sessionStorage.getItem('markr:wallCache:square')).toBeNull()
    expect(load('square', 2000)).toBeNull()
  })

  it('returns null when getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(load('square')).toBeNull()
  })
})
