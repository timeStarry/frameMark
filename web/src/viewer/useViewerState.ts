// Frame position for the viewer. The sequence is the collection's frames plus
// one end frame (index frames.length + 1). Indices are 1-based, as in `?f=`.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { Dir } from './gesture'

/** Frames on each side of the current one that keep real <img> nodes (spec §8). */
export const WINDOW_RADIUS = 2

export interface ViewerStateOptions {
  /** Number of collection frames, without the end frame. */
  frameCount: Readonly<Ref<number>>
  initial: number
  mode: Readonly<Ref<'public' | 'preview'>>
  /** Called when stepping forward past the end frame (public mode only). */
  onNavigate(dir: Dir): void
}

export interface ViewerState {
  current: ComputedRef<number>
  /** Sequence length, end frame included. */
  total: ComputedRef<number>
  go(n: number): void
  step(dir: Dir): void
  /** Indices within current ± WINDOW_RADIUS. */
  window: ComputedRef<ReadonlySet<number>>
}

export function useViewerState(o: ViewerStateOptions): ViewerState {
  const total = computed(() => Math.max(0, Math.floor(o.frameCount.value)) + 1)
  const clamp = (n: number) => Math.min(total.value, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 1))

  const raw = ref(clamp(o.initial))
  // Re-clamped on read, so a shrinking sequence never leaves current out of range.
  const current = computed(() => clamp(raw.value))

  const go = (n: number) => {
    raw.value = clamp(n)
  }

  const step = (dir: Dir) => {
    if (dir === 1 && current.value === total.value) {
      if (o.mode.value === 'public') o.onNavigate(1)
      return
    }
    go(current.value + dir)
  }

  const window = computed<ReadonlySet<number>>(() => {
    const s = new Set<number>()
    const lo = Math.max(1, current.value - WINDOW_RADIUS)
    const hi = Math.min(total.value, current.value + WINDOW_RADIUS)
    for (let i = lo; i <= hi; i++) s.add(i)
    return s
  })

  return { current, total, go, step, window }
}
