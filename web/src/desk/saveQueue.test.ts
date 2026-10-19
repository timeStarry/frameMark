import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLane } from './saveQueue'

type R = { ok: true } | { ok: false; message: string; conflict?: boolean }

/** A send whose calls resolve only when the test says so. */
function controlled() {
  const calls: { v: number; resolve: (r: R) => void; reject: (e: unknown) => void }[] = []
  const send = vi.fn(
    (v: number) =>
      new Promise<R>((resolve, reject) => {
        calls.push({ v, resolve, reject })
      }),
  )
  return { send, calls }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
})

describe('createLane', () => {
  it('debounces and keeps only the latest value', async () => {
    const send = vi.fn(async (_v: number): Promise<R> => ({ ok: true }))
    const lane = createLane(send, () => {})
    lane.schedule(1, { debounceMs: 800 })
    await vi.advanceTimersByTimeAsync(500)
    lane.schedule(2, { debounceMs: 800 })
    await vi.advanceTimersByTimeAsync(500)
    expect(send).not.toHaveBeenCalled()
    expect(lane.state.value).toBe('pending')
    expect(lane.pendingValue()).toBe(2)
    await vi.advanceTimersByTimeAsync(300)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(2)
    expect(lane.state.value).toBe('idle')
    expect(lane.pendingValue()).toBeUndefined()
  })

  it('defaults to sending on the next macrotask', async () => {
    const send = vi.fn(async (_v: number): Promise<R> => ({ ok: true }))
    const lane = createLane(send, () => {})
    lane.schedule(1)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledWith(1)
  })

  it('keeps one send in flight and coalesces later values into one next send', async () => {
    const { send, calls } = controlled()
    const lane = createLane(send, () => {})
    lane.schedule(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(lane.state.value).toBe('saving')
    lane.schedule(2)
    lane.schedule(3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(1)
    calls[0]!.resolve({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(3)
    calls[1]!.resolve({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(send.mock.calls.map((c) => c[0])).toEqual([1, 3])
    expect(lane.state.value).toBe('idle')
  })

  it('sends the next value without waiting for a fresh debounce', async () => {
    const { send, calls } = controlled()
    const lane = createLane(send, () => {})
    lane.schedule(1)
    await vi.advanceTimersByTimeAsync(0)
    lane.schedule(2, { debounceMs: 800 })
    calls[0]!.resolve({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenLastCalledWith(2)
  })

  it('flush sends now and resolves once everything settled', async () => {
    const { send, calls } = controlled()
    const lane = createLane(send, () => {})
    lane.schedule(1, { debounceMs: 800 })
    let done = false
    const p = lane.flush().then(() => {
      done = true
    })
    await Promise.resolve()
    expect(send).toHaveBeenCalledWith(1)
    lane.schedule(2, { debounceMs: 800 })
    calls[0]!.resolve({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    expect(send).toHaveBeenLastCalledWith(2)
    calls[1]!.resolve({ ok: true })
    await p
    expect(done).toBe(true)
    expect(lane.state.value).toBe('idle')
  })

  it('flush resolves immediately when idle and resolves (not rejects) on failure', async () => {
    const send = vi.fn(async (_v: number): Promise<R> => ({ ok: false, message: 'boom' }))
    const lane = createLane(send, () => {})
    await expect(lane.flush()).resolves.toBeUndefined()
    lane.schedule(1, { debounceMs: 800 })
    await expect(lane.flush()).resolves.toBeUndefined()
    expect(lane.state.value).toBe('error')
  })

  it('keeps the value on error and retry resends it', async () => {
    const send = vi
      .fn<(v: number) => Promise<R>>()
      .mockResolvedValueOnce({ ok: false, message: '标题太长' })
      .mockResolvedValueOnce({ ok: true })
    const lane = createLane(send, () => {})
    lane.schedule(7)
    await vi.advanceTimersByTimeAsync(0)
    expect(lane.state.value).toBe('error')
    expect(lane.error.value).toBe('标题太长')
    expect(lane.pendingValue()).toBe(7)
    lane.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(7)
    expect(lane.state.value).toBe('idle')
    expect(lane.error.value).toBe('')
  })

  it('treats a throwing send as a failure without unhandled rejections', async () => {
    const send = vi.fn(async (_v: number): Promise<R> => {
      throw new Error('network')
    })
    const lane = createLane(send, () => {})
    lane.schedule(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(lane.state.value).toBe('error')
    expect(lane.error.value).toBe('保存失败，请重试')
    expect(lane.pendingValue()).toBe(1)
  })

  it('a conflict pauses, calls onConflict once and keeps the value', async () => {
    const send = vi.fn(async (_v: number): Promise<R> => ({ ok: false, message: '冲突', conflict: true }))
    const onConflict = vi.fn()
    const lane = createLane(send, onConflict)
    lane.schedule(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(lane.state.value).toBe('paused')
    expect(onConflict).toHaveBeenCalledTimes(1)
    lane.schedule(2)
    await vi.advanceTimersByTimeAsync(1000)
    await lane.flush()
    lane.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)
    expect(onConflict).toHaveBeenCalledTimes(1)
    expect(lane.pendingValue()).toBe(2)
  })

  it('a conflict during a second pause calls onConflict again', async () => {
    const send = vi.fn(async (_v: number): Promise<R> => ({ ok: false, message: 'x', conflict: true }))
    const onConflict = vi.fn()
    const lane = createLane(send, onConflict)
    lane.schedule(1)
    await vi.advanceTimersByTimeAsync(0)
    lane.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(2)
    expect(onConflict).toHaveBeenCalledTimes(2)
  })

  it('pause holds values and resume sends the latest', async () => {
    const send = vi.fn(async (_v: number): Promise<R> => ({ ok: true }))
    const lane = createLane(send, () => {})
    lane.pause()
    lane.schedule(1)
    lane.schedule(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).not.toHaveBeenCalled()
    expect(lane.state.value).toBe('paused')
    lane.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(2)
    expect(lane.state.value).toBe('idle')
  })

  it('resume with nothing pending goes idle', async () => {
    const send = vi.fn(async (_v: number): Promise<R> => ({ ok: true }))
    const lane = createLane(send, () => {})
    lane.pause()
    lane.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(send).not.toHaveBeenCalled()
    expect(lane.state.value).toBe('idle')
  })

  it('pause during a send keeps the newer value unsent', async () => {
    const { send, calls } = controlled()
    const lane = createLane(send, () => {})
    lane.schedule(1)
    await vi.advanceTimersByTimeAsync(0)
    lane.schedule(2)
    lane.pause()
    calls[0]!.resolve({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)
    expect(lane.state.value).toBe('paused')
    expect(lane.pendingValue()).toBe(2)
  })

  it('dispose leaves no timers and ignores a late send result', async () => {
    const { send, calls } = controlled()
    const lane = createLane(send, () => {})
    lane.schedule(1)
    await vi.advanceTimersByTimeAsync(0)
    lane.schedule(2, { debounceMs: 800 })
    lane.dispose()
    expect(vi.getTimerCount()).toBe(0)
    const before = lane.state.value
    calls[0]!.resolve({ ok: false, message: 'late', conflict: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(lane.state.value).toBe(before)
    expect(lane.error.value).toBe('')
  })
})
