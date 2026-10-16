import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useViewerState } from './useViewerState'

function mk(frameCount: number, initial: number, mode: 'public' | 'preview' = 'public') {
  const onNavigate = vi.fn()
  const s = useViewerState({ frameCount: ref(frameCount), initial, mode: ref(mode), onNavigate })
  return { s, onNavigate }
}

describe('useViewerState', () => {
  it('counts the end frame in total', () => {
    const { s } = mk(12, 1)
    expect(s.total.value).toBe(13)
    expect(s.current.value).toBe(1)
  })

  it('clamps the initial frame', () => {
    expect(mk(12, 0).s.current.value).toBe(1)
    expect(mk(12, 99).s.current.value).toBe(13)
    expect(mk(12, 2.7).s.current.value).toBe(2)
  })

  it('go clamps to [1, total]', () => {
    const { s } = mk(12, 5)
    s.go(-3)
    expect(s.current.value).toBe(1)
    s.go(40)
    expect(s.current.value).toBe(13)
    s.go(7)
    expect(s.current.value).toBe(7)
  })

  it('step moves by one and clamps at the first frame', () => {
    const { s, onNavigate } = mk(12, 2)
    s.step(-1)
    expect(s.current.value).toBe(1)
    s.step(-1)
    expect(s.current.value).toBe(1)
    s.step(1)
    expect(s.current.value).toBe(2)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('step(1) on the end frame navigates to the next collection', () => {
    const { s, onNavigate } = mk(12, 13)
    s.step(1)
    expect(onNavigate).toHaveBeenCalledWith(1)
    expect(s.current.value).toBe(13)
  })

  it('step(1) on the end frame does nothing in preview mode', () => {
    const { s, onNavigate } = mk(12, 13, 'preview')
    s.step(1)
    expect(onNavigate).not.toHaveBeenCalled()
    expect(s.current.value).toBe(13)
  })

  it('window holds current ±2, clamped to the sequence', () => {
    const { s } = mk(12, 6)
    expect([...s.window.value].sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8])
    s.go(1)
    expect([...s.window.value].sort((a, b) => a - b)).toEqual([1, 2, 3])
    s.go(13)
    expect([...s.window.value].sort((a, b) => a - b)).toEqual([11, 12, 13])
  })

  it('window stays at 5 for long collections', () => {
    const { s } = mk(500, 250)
    expect(s.window.value.size).toBe(5)
  })

  it('re-clamps when the frame count shrinks', () => {
    const count = ref(12)
    const s = useViewerState({ frameCount: count, initial: 13, mode: ref('public'), onNavigate: () => {} })
    count.value = 4
    expect(s.current.value).toBe(5)
  })
})
