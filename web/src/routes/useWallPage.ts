// Shared lifecycle for wall pages (spec §6, §8): render a cache synchronously,
// fetch fresh data in the background, restore focus once after the first
// render, save a snapshot when leaving, and own the document title.
import { nextTick, onBeforeUnmount, ref, type Ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import type { Result } from '../api/client'
import { load, save } from '../walls/wallCache'
import { restoreFocus } from '../walls/restore'

export type WallPageState = 'idle' | 'loading' | 'error' | 'missing'

export interface WallPageOptions<T, S> {
  /** Cache key and restore scope: `square`, `user:{id}` or `album:{id}`. */
  wall: string
  fetcher: (signal: AbortSignal) => Promise<Result<T>>
  /** Render a cached snapshot (synchronously, during setup). */
  fromCache: (s: S) => void
  /** Fresh data arrived; `hadCache` means a cached snapshot is on screen. */
  fromFresh: (t: T, hadCache: boolean) => void
  /** What is on screen now, saved when leaving; null saves nothing. */
  snapshot: () => S | null
}

export function useWallPage<T, S>(o: WallPageOptions<T, S>): {
  state: Ref<WallPageState>
  rootEl: Ref<HTMLElement | null>
  retry: () => void
} {
  try {
    history.scrollRestoration = 'manual'
  } catch {
    // ignore: not available or not writable here
  }

  const state = ref<WallPageState>('loading')
  const rootEl = ref<HTMLElement | null>(null)
  let ctrl: AbortController | null = null
  // Restore runs once, after whichever render comes first (cache or fresh).
  let restored = false

  async function restore() {
    if (restored) return
    restored = true
    await nextTick()
    if (rootEl.value) restoreFocus(rootEl.value, o.wall)
  }

  const cached = load<S>(o.wall)
  if (cached !== null) {
    o.fromCache(cached)
    state.value = 'idle'
    void restore()
  }

  async function run() {
    ctrl?.abort()
    const c = new AbortController()
    ctrl = c
    const r = await o.fetcher(c.signal)
    if (c.signal.aborted) return
    if (!r.ok) {
      if (r.status === -1) return
      if (r.status === 404) state.value = 'missing'
      else if (cached === null) state.value = 'error'
      // With a cache on screen a failed refresh stays silent.
      return
    }
    o.fromFresh(r.data, cached !== null)
    state.value = 'idle'
    await restore()
  }

  function retry() {
    state.value = 'loading'
    void run()
  }

  function persist() {
    const s = o.snapshot()
    if (s !== null) save(o.wall, s)
  }

  onBeforeRouteLeave(() => {
    persist()
  })
  onBeforeUnmount(() => {
    ctrl?.abort()
    persist()
    document.title = 'Markr'
  })

  void run()
  return { state, rootEl, retry }
}
