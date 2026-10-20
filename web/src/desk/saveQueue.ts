// saveQueue.ts — a "save lane" for the curation desk (spec §4.5, §6).
// Each lane holds only the latest unsaved value, sends at most one write at a
// time, and coalesces edits made during a send into one follow-up write. A 409
// pauses the lane; any other failure keeps the value for retry().
import { readonly, ref, type Ref } from 'vue'

export type LaneState = 'idle' | 'pending' | 'saving' | 'error' | 'paused'

export type SendResult = { ok: true } | { ok: false; message: string; conflict?: boolean }

export interface Lane<T> {
  /** Replaces the pending value and (re)starts the debounce (default 0ms). */
  schedule(value: T, opts?: { debounceMs?: number }): void
  /** Sends the latest value now; resolves once the lane settles. Never rejects. */
  flush(): Promise<void>
  /** Resends the kept value after an error. */
  retry(): void
  pause(): void
  resume(): void
  /** The value not yet confirmed saved, if any (excludes a send in flight). */
  pendingValue(): T | undefined
  state: Readonly<Ref<LaneState>>
  error: Readonly<Ref<string>>
  dispose(): void
}

const FALLBACK_MESSAGE = '保存失败，请重试'

export function createLane<T>(send: (v: T) => Promise<SendResult>, onConflict: () => void): Lane<T> {
  const state = ref<LaneState>('idle')
  const error = ref('')
  let pending: { value: T } | null = null
  let inflight = false
  let paused = false
  let conflictNotified = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let waiters: (() => void)[] = []

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** Nothing will happen without outside input: resolve flush() callers. */
  function settleIfQuiet(): void {
    if (disposed || (!inflight && timer === null && (pending === null || paused || state.value === 'error'))) {
      const ws = waiters
      waiters = []
      for (const w of ws) w()
    }
  }

  async function pump(): Promise<void> {
    if (disposed || paused || inflight || pending === null) {
      settleIfQuiet()
      return
    }
    clearTimer()
    const { value } = pending
    pending = null
    inflight = true
    state.value = 'saving'
    let r: SendResult
    try {
      r = await send(value)
    } catch {
      r = { ok: false, message: FALLBACK_MESSAGE }
    }
    if (disposed) return
    inflight = false
    if (r.ok) {
      error.value = ''
      if (paused) state.value = 'paused'
      else if (pending !== null) return pump()
      else state.value = 'idle'
    } else {
      // Keep the failed value unless a newer edit already replaced it.
      if (pending === null) pending = { value }
      if (r.conflict) {
        paused = true
        state.value = 'paused'
        if (!conflictNotified) {
          conflictNotified = true
          try {
            onConflict()
          } catch {
            // The lane state is already correct; a faulty handler must not escape.
          }
        }
      } else {
        error.value = r.message || FALLBACK_MESSAGE
        state.value = paused ? 'paused' : 'error'
      }
    }
    settleIfQuiet()
  }

  return {
    schedule(value, opts) {
      if (disposed) return
      pending = { value }
      if (paused) return
      if (inflight) return // picked up as soon as the current send finishes
      clearTimer()
      error.value = ''
      state.value = 'pending'
      timer = setTimeout(() => {
        timer = null
        void pump()
      }, opts?.debounceMs ?? 0)
    },
    flush() {
      if (disposed) return Promise.resolve()
      const done = new Promise<void>((resolve) => waiters.push(resolve))
      clearTimer()
      if (!paused && !inflight && pending !== null) void pump()
      else settleIfQuiet()
      return done
    },
    retry() {
      if (disposed || state.value !== 'error') return
      void pump()
    },
    pause() {
      if (disposed) return
      paused = true
      clearTimer()
      if (!inflight) state.value = 'paused'
      settleIfQuiet()
    },
    resume() {
      if (disposed || !paused) return
      paused = false
      conflictNotified = false
      if (inflight) state.value = 'saving'
      else if (pending !== null) void pump()
      else state.value = 'idle'
    },
    pendingValue() {
      return pending?.value
    },
    state: readonly(state),
    error: readonly(error),
    dispose() {
      disposed = true
      clearTimer()
      settleIfQuiet()
    },
  }
}
