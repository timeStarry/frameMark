import { describe, expect, it } from 'vitest'
import { History } from './history'

describe('History', () => {
  it('commits a drag once, recovers a removal, and drops duplicate snapshots', () => {
    const h = new History({ assetIds: ['a'], border: 6 }, 2)
    const transient = { ...h.value, border: 8 }
    transient.border = 12
    h.commit(transient)
    expect(h.past).toHaveLength(1)

    h.commit({ ...h.value, assetIds: [] })
    expect(h.undo().assetIds).toEqual(['a'])
    expect(h.redo().assetIds).toEqual([])

    h.commit({ ...h.value, border: 14 })
    expect(h.future).toHaveLength(0)
    expect(h.past).toHaveLength(2)

    h.commit(h.value)
    expect(h.past).toHaveLength(2)
  })

  it('caps the past at 50 steps by default', () => {
    const h = new History({ n: 0 })
    for (let n = 1; n <= 60; n++) h.commit({ n })
    expect(h.past).toHaveLength(50)
    expect(h.value).toEqual({ n: 60 })
    expect(h.past[0]).toEqual({ n: 10 })
  })
})
