import { afterEach, describe, expect, it, vi } from 'vitest'
import { recall, remember } from './lastViewed'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  try {
    sessionStorage.clear()
  } catch {
    // ignore
  }
})

describe('lastViewed', () => {
  it('stores under markr:lastViewed:{wall}', () => {
    remember('square', 'c1')
    expect(sessionStorage.getItem('markr:lastViewed:square')).toBe('c1')
    expect(recall('square')).toBe('c1')
  })

  it('keeps walls separate', () => {
    remember('square', 'c1')
    remember('album:a1', 'c2')
    expect(recall('square')).toBe('c1')
    expect(recall('album:a1')).toBe('c2')
    expect(recall('user:u1')).toBeNull()
  })

  it('does not throw when sessionStorage throws', () => {
    vi.stubGlobal('sessionStorage', {
      setItem() {
        throw new DOMException('quota', 'QuotaExceededError')
      },
      getItem() {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    expect(() => remember('square', 'c1')).not.toThrow()
    expect(recall('square')).toBeNull()
  })

  it('does not throw when accessing sessionStorage itself throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    try {
      expect(() => remember('square', 'c1')).not.toThrow()
      expect(recall('square')).toBeNull()
    } finally {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original)
    }
  })
})
