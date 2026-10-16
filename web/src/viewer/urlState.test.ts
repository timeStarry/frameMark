import { describe, expect, it } from 'vitest'
import { frameQuery, readState, shareURL } from './urlState'

describe('readState', () => {
  it.each<[Record<string, string | null | (string | null)[]>, number]>([
    [{}, 1],
    [{ f: '1' }, 1],
    [{ f: '3' }, 3],
    [{ f: '999' }, 999],
    [{ f: '0' }, 1],
    [{ f: '-1' }, 1],
    [{ f: 'abc' }, 1],
    [{ f: '2.5' }, 1],
    [{ f: '3abc' }, 1],
    [{ f: '' }, 1],
    [{ f: null }, 1],
    [{ f: ['4', '5'] }, 4],
    [{ f: '99999999999999999999' }, 1],
  ])('frame from %j -> %i', (query, want) => {
    expect(readState({ query }).frame).toBe(want)
  })

  it('treats a frame beyond frameCount as 1 when the count is known', () => {
    expect(readState({ query: { f: '999' } }, 12).frame).toBe(1)
    expect(readState({ query: { f: '12' } }, 12).frame).toBe(12)
  })

  it.each<[Record<string, string | null | (string | null)[]>, string | null]>([
    [{}, null],
    [{ wall: 'square' }, 'square'],
    [{ wall: 'album:a1' }, 'album:a1'],
    [{ wall: '' }, null],
    [{ wall: null }, null],
    [{ wall: ['user', 'square'] }, 'user'],
  ])('wall from %j -> %s', (query, want) => {
    expect(readState({ query }).wall).toBe(want)
  })
})

describe('frameQuery', () => {
  it('serialises the frame number', () => {
    expect(frameQuery(3)).toEqual({ f: '3' })
    expect(frameQuery(1)).toEqual({ f: '1' })
  })
})

describe('shareURL', () => {
  it('never carries wall', () => {
    const u = shareURL('https://markr.example', 'c1', 4)
    expect(u).toBe('https://markr.example/c/c1?f=4')
    expect(u).not.toContain('wall')
  })

  it('omits f when absent or 1', () => {
    expect(shareURL('https://markr.example', 'c1')).toBe('https://markr.example/c/c1')
    expect(shareURL('https://markr.example', 'c1', 1)).toBe('https://markr.example/c/c1')
  })

  it('encodes the id and ignores invalid frames', () => {
    expect(shareURL('http://127.0.0.1:18150', 'a/b', 0)).toBe('http://127.0.0.1:18150/c/a%2Fb')
  })
})
