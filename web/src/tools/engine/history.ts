import { LIMITS } from './limits'

export class History<T> {
  past: T[] = []
  future: T[] = []

  constructor(
    public value: T,
    readonly limit: number = LIMITS.historySteps,
  ) {}

  commit(next: T): void {
    if (JSON.stringify(next) === JSON.stringify(this.value)) return
    this.past.push(structuredClone(this.value))
    this.past = this.past.slice(-this.limit)
    this.value = structuredClone(next)
    this.future = []
  }

  undo(): T {
    const prev = this.past.pop()
    if (prev) {
      this.future.push(this.value)
      this.value = prev
    }
    return this.value
  }

  redo(): T {
    const next = this.future.pop()
    if (next) {
      this.past.push(this.value)
      this.value = next
    }
    return this.value
  }
}
