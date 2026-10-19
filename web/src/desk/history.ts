// Generic undo/redo stack (spec §4.6). Holds immutable snapshots; `max` caps
// the number of undo steps kept.
export interface History<T> {
  current(): T
  push(next: T): void
  undo(): T | null
  redo(): T | null
  canUndo(): boolean
  canRedo(): boolean
  reset(v: T): void
}

export function createHistory<T>(initial: T, max = 50): History<T> {
  let past: T[] = []
  let future: T[] = []
  let present = initial

  return {
    current: () => present,
    push(next) {
      past.push(present)
      if (past.length > max) past.splice(0, past.length - max)
      present = next
      future = []
    },
    undo() {
      if (past.length === 0) return null
      future.push(present)
      present = past.pop() as T
      return present
    },
    redo() {
      if (future.length === 0) return null
      past.push(present)
      present = future.pop() as T
      return present
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    reset(v) {
      past = []
      future = []
      present = v
    },
  }
}
