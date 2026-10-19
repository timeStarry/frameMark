import { describe, expect, it } from 'vitest'
import {
  MAX_FRAMES,
  allowedLayouts,
  fromOwner,
  insertPhotos,
  insertText,
  isValid,
  merge,
  move,
  photoIds,
  remove,
  setLayout,
  setMatte,
  setText,
  split,
  toInput,
  type DeskFrame,
  type DeskPhoto,
  type Seq,
} from './sequence'

const p = (id: string): DeskPhoto => ({ id, title: id, media: null, width: null, height: null })

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v as object).forEach(deepFreeze)
    Object.freeze(v)
  }
  return v
}

function seqOf(...frames: Omit<DeskFrame, 'key'>[]): Seq {
  return deepFreeze(frames.map((f, i) => ({ key: `k${i}`, ...f })))
}
const full = (id: string): Omit<DeskFrame, 'key'> => ({ layout: 'full', matteRatio: null, text: null, photos: [p(id)] })
const matted = (id: string, r = 0.7): Omit<DeskFrame, 'key'> => ({ layout: 'matted', matteRatio: r, text: null, photos: [p(id)] })
const pair = (...ids: string[]): Omit<DeskFrame, 'key'> => ({ layout: 'pair', matteRatio: null, text: null, photos: ids.map(p) })
const text = (t: string): Omit<DeskFrame, 'key'> => ({ layout: 'text', matteRatio: null, text: t, photos: [] })

describe('fromOwner / toInput', () => {
  it('generates stable distinct keys and maps fields', () => {
    const s = fromOwner(deepFreeze({
      frames: [
        { layout: 'full' as const, matteRatio: null, text: null, photos: [{ id: 'a', title: 'A', media: null, width: 3, height: 2 }] },
        { layout: 'text' as const, matteRatio: null, text: 'hi', photos: [] },
      ],
    }))
    expect(s).toHaveLength(2)
    expect(s[0]!.key).not.toBe(s[1]!.key)
    expect(s[0]!.photos[0]).toEqual({ id: 'a', title: 'A', media: null, width: 3, height: 2 })
    expect(toInput(s)).toEqual([
      { layout: 'full', matteRatio: null, text: null, photoIds: ['a'] },
      { layout: 'text', matteRatio: null, text: 'hi', photoIds: [] },
    ])
  })

  it('toInput drops matteRatio for non-matted and text for non-text', () => {
    const s = seqOf(matted('a', 0.6), { ...full('b'), matteRatio: 0.7, text: 'x' })
    expect(toInput(s)).toEqual([
      { layout: 'matted', matteRatio: 0.6, text: null, photoIds: ['a'] },
      { layout: 'full', matteRatio: null, text: null, photoIds: ['b'] },
    ])
  })
})

describe('insertPhotos / insertText', () => {
  it('inserts one full frame per photo at the index', () => {
    const s = seqOf(full('a'), full('b'))
    const out = insertPhotos(s, 1, [p('x'), p('y')])
    expect(out.map((f) => f.photos[0]!.id)).toEqual(['a', 'x', 'y', 'b'])
    expect(out[1]!.layout).toBe('full')
    expect(out[1]!.key).not.toBe(out[2]!.key)
    expect(out[0]!.key).toBe('k0')
    expect(out[3]!.key).toBe('k1')
  })

  it('appends at length and ignores out-of-range', () => {
    const s = seqOf(full('a'))
    expect(insertPhotos(s, 1, [p('x')]).map((f) => f.photos[0]!.id)).toEqual(['a', 'x'])
    expect(insertPhotos(s, 2, [p('x')])).toBe(s)
    expect(insertPhotos(s, -1, [p('x')])).toBe(s)
    expect(insertText(s, 5)).toBe(s)
  })

  it('respects the 200 frame limit', () => {
    const many = deepFreeze(Array.from({ length: MAX_FRAMES - 1 }, (_, i) => ({ key: `k${i}`, ...full(`p${i}`) })))
    expect(insertPhotos(many, 0, [p('x'), p('y')])).toBe(many)
    expect(insertPhotos(many, 0, [p('x')])).toHaveLength(MAX_FRAMES)
    const max = insertText(many, 0)
    expect(max).toHaveLength(MAX_FRAMES)
    expect(insertText(max, 0)).toBe(max)
  })

  it('insertText adds an empty text frame', () => {
    const s = seqOf(full('a'))
    const out = insertText(s, 0)
    expect(out[0]!).toMatchObject({ layout: 'text', text: '', photos: [], matteRatio: null })
  })
})

describe('remove / move', () => {
  it('removes by index', () => {
    const s = seqOf(full('a'), full('b'))
    expect(remove(s, 0).map((f) => f.key)).toEqual(['k1'])
    expect(remove(s, 2)).toBe(s)
  })

  it('moves frames and keeps keys', () => {
    const s = seqOf(full('a'), full('b'), full('c'))
    expect(move(s, 0, 2).map((f) => f.key)).toEqual(['k1', 'k2', 'k0'])
    expect(move(s, 2, 0).map((f) => f.key)).toEqual(['k2', 'k0', 'k1'])
    expect(move(s, 1, 1)).toBe(s)
    expect(move(s, 0, 3)).toBe(s)
    expect(move(s, -1, 0)).toBe(s)
  })
})

describe('setLayout / allowedLayouts', () => {
  it('lists allowed layouts by photo count', () => {
    expect(allowedLayouts({ key: 'x', ...full('a') })).toEqual(['full', 'matted'])
    expect(allowedLayouts({ key: 'x', ...pair('a', 'b') })).toEqual(['pair'])
    expect(allowedLayouts({ key: 'x', ...text('t') })).toEqual(['text'])
  })

  it('full to matted defaults 0.8 and back clears it', () => {
    const s = seqOf(full('a'))
    const m = setLayout(s, 0, 'matted')
    expect(m[0]!).toMatchObject({ layout: 'matted', matteRatio: 0.8, key: 'k0' })
    expect(setLayout(m, 0, 'full')[0]!).toMatchObject({ layout: 'full', matteRatio: null })
  })

  it('keeps an existing matte ratio', () => {
    const s = seqOf({ ...full('a'), matteRatio: 0.6 })
    expect(setLayout(s, 0, 'matted')[0]!.matteRatio).toBe(0.6)
  })

  it('rejects illegal layouts and out-of-range', () => {
    const s = seqOf(full('a'), pair('b', 'c'))
    expect(setLayout(s, 0, 'pair')).toBe(s)
    expect(setLayout(s, 0, 'text')).toBe(s)
    expect(setLayout(s, 1, 'full')).toBe(s)
    expect(setLayout(s, 0, 'full')).toBe(s)
    expect(setLayout(s, 9, 'matted')).toBe(s)
  })
})

describe('setMatte / setText', () => {
  it('clamps matte ratio on matted frames only', () => {
    const s = seqOf(matted('a'), full('b'))
    expect(setMatte(s, 0, 0.2)[0]!.matteRatio).toBe(0.5)
    expect(setMatte(s, 0, 1)[0]!.matteRatio).toBe(0.95)
    expect(setMatte(s, 0, 0.66)[0]!.matteRatio).toBe(0.66)
    expect(setMatte(s, 1, 0.6)).toBe(s)
    expect(setMatte(s, 2, 0.6)).toBe(s)
  })

  it('sets text on text frames only', () => {
    const s = seqOf(text(''), full('a'))
    expect(setText(s, 0, 'hello')[0]!.text).toBe('hello')
    expect(setText(s, 1, 'x')).toBe(s)
    expect(setText(s, 3, 'x')).toBe(s)
  })
})

describe('merge', () => {
  it('full into full makes a pair of 2 and keeps the target key', () => {
    const s = seqOf(full('a'), full('b'), full('c'))
    const out = merge(s, 2, 0)
    expect(out).toHaveLength(2)
    expect(out[0]!).toMatchObject({ key: 'k0', layout: 'pair', matteRatio: null, text: null })
    expect(out[0]!.photos.map((x) => x.id)).toEqual(['a', 'c'])
    expect(out[1]!.key).toBe('k1')
  })

  it('matted into matted makes a pair and clears matte', () => {
    const s = seqOf(matted('a'), matted('b'))
    const out = merge(s, 0, 1)
    expect(out).toHaveLength(1)
    expect(out[0]!).toMatchObject({ key: 'k1', layout: 'pair', matteRatio: null })
    expect(out[0]!.photos.map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('into a pair of 2 makes 3', () => {
    const s = seqOf(pair('a', 'b'), full('c'))
    const out = merge(s, 1, 0)
    expect(out).toHaveLength(1)
    expect(out[0]!.photos.map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('rejects a pair of 3, duplicates, text, pair sources, self, out-of-range', () => {
    const s = seqOf(pair('a', 'b', 'c'), full('d'), full('a'), text('t'), pair('e', 'f'))
    expect(merge(s, 1, 0)).toBe(s)
    expect(merge(s, 2, 0)).toBe(s)
    expect(merge(s, 1, 3)).toBe(s)
    expect(merge(s, 3, 1)).toBe(s)
    expect(merge(s, 4, 1)).toBe(s)
    expect(merge(s, 1, 1)).toBe(s)
    expect(merge(s, 1, 9)).toBe(s)
    expect(merge(s, -1, 1)).toBe(s)
  })
})

describe('split', () => {
  it('splits a pair into full frames in place with new keys', () => {
    const s = seqOf(full('x'), pair('a', 'b', 'c'), full('y'))
    const out = split(s, 1)
    expect(out.map((f) => f.layout)).toEqual(['full', 'full', 'full', 'full', 'full'])
    expect(out.map((f) => f.photos[0]!.id)).toEqual(['x', 'a', 'b', 'c', 'y'])
    const keys = out.map((f) => f.key)
    expect(new Set(keys).size).toBe(5)
    expect(keys[0]).toBe('k0')
    expect(keys[4]).toBe('k2')
    expect(keys.slice(1, 4)).not.toContain('k1')
  })

  it('does nothing for non-pairs, out-of-range, or over the limit', () => {
    const s = seqOf(full('a'), text('t'))
    expect(split(s, 0)).toBe(s)
    expect(split(s, 1)).toBe(s)
    expect(split(s, 2)).toBe(s)
    const many = deepFreeze([
      { key: 'p', ...pair('a', 'b') },
      ...Array.from({ length: MAX_FRAMES - 1 }, (_, i) => ({ key: `k${i}`, ...full(`p${i}`) })),
    ])
    expect(split(many, 0)).toBe(many)
  })
})

describe('isValid / photoIds', () => {
  it('accepts a valid sequence', () => {
    expect(isValid(seqOf(full('a'), pair('b', 'c'), text('t')))).toEqual({ ok: true })
    expect(isValid([])).toEqual({ ok: true })
  })

  it('reports the first empty text frame', () => {
    const r = isValid(seqOf(full('a'), text(''), text('')))
    expect(r).toMatchObject({ ok: false, index: 1 })
  })

  it('reports text over 2000 characters', () => {
    expect(isValid(seqOf(text('x'.repeat(2001))))).toMatchObject({ ok: false, index: 0 })
    expect(isValid(seqOf(text('x'.repeat(2000))))).toEqual({ ok: true })
  })

  it('reports a pair with fewer than 2 photos', () => {
    expect(isValid(seqOf(full('a'), pair('b')))).toMatchObject({ ok: false, index: 1 })
  })

  it('reports more than 200 frames', () => {
    const many = Array.from({ length: MAX_FRAMES + 1 }, (_, i) => ({ key: `k${i}`, ...full(`p${i}`) }))
    expect(isValid(many)).toMatchObject({ ok: false, index: MAX_FRAMES })
  })

  it('collects photo ids', () => {
    expect(photoIds(seqOf(full('a'), pair('b', 'c'), text('t')))).toEqual(new Set(['a', 'b', 'c']))
  })
})
