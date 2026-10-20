import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { listeners } = vi.hoisted(() => ({ listeners: [] as (() => void)[] }))
vi.mock('../api/session', () => ({
  onIdentityChange: (fn: () => void) => {
    listeners.push(fn)
    return () => {}
  },
}))

import { saveBackup, loadBackup, clearBackup, clearAllBackups, type Backup } from './backup'

const sample: Backup<{ title: string }, { photoId: string }[]> = {
  baseUpdatedAt: 100,
  savedAt: 200,
  fields: { title: '海边' },
  frames: [{ photoId: 'p1' }],
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('backup', () => {
  it('round-trips under markr:desk:{id}', () => {
    saveBackup('c1', sample)
    expect(localStorage.getItem('markr:desk:c1')).not.toBeNull()
    expect(loadBackup<{ title: string }, { photoId: string }[]>('c1')).toEqual(sample)
    clearBackup('c1')
    expect(loadBackup('c1')).toBeNull()
  })

  it('returns null for a missing key', () => {
    expect(loadBackup('none')).toBeNull()
  })

  it('drops corrupt JSON', () => {
    localStorage.setItem('markr:desk:c1', '{not json')
    expect(loadBackup('c1')).toBeNull()
    expect(localStorage.getItem('markr:desk:c1')).toBeNull()
  })

  it.each([
    ['null', 'null'],
    ['non-finite baseUpdatedAt', JSON.stringify({ baseUpdatedAt: 'x', savedAt: 1, fields: {}, frames: [] })],
    ['missing savedAt', JSON.stringify({ baseUpdatedAt: 1, fields: {}, frames: [] })],
    ['missing fields', JSON.stringify({ baseUpdatedAt: 1, savedAt: 1, frames: [] })],
    ['missing frames', JSON.stringify({ baseUpdatedAt: 1, savedAt: 1, fields: {} })],
  ])('drops an invalid shape (%s)', (_name, raw) => {
    localStorage.setItem('markr:desk:c1', raw)
    expect(loadBackup('c1')).toBeNull()
    expect(localStorage.getItem('markr:desk:c1')).toBeNull()
  })

  it('stays silent when storage throws', () => {
    const boom = () => {
      throw new Error('blocked')
    }
    vi.stubGlobal('localStorage', {
      get length(): number {
        return boom()
      },
      getItem: boom,
      setItem: boom,
      removeItem: boom,
      key: boom,
      clear: boom,
    })
    expect(() => saveBackup('c1', sample)).not.toThrow()
    expect(loadBackup('c1')).toBeNull()
    expect(() => clearBackup('c1')).not.toThrow()
    expect(() => clearAllBackups()).not.toThrow()
  })

  it('clearAllBackups removes only desk keys', () => {
    saveBackup('a', sample)
    saveBackup('b', sample)
    saveBackup('c', sample)
    localStorage.setItem('markr:other', '1')
    localStorage.setItem('unrelated', '2')
    clearAllBackups()
    expect(loadBackup('a')).toBeNull()
    expect(loadBackup('b')).toBeNull()
    expect(loadBackup('c')).toBeNull()
    expect(localStorage.getItem('markr:other')).toBe('1')
    expect(localStorage.getItem('unrelated')).toBe('2')
  })

  it('clears every backup on identity change', () => {
    saveBackup('a', sample)
    localStorage.setItem('markr:other', '1')
    expect(listeners).toContain(clearAllBackups)
    for (const fn of listeners) fn()
    expect(loadBackup('a')).toBeNull()
    expect(localStorage.getItem('markr:other')).toBe('1')
  })
})
