// DOM-free input state machine for the viewer (spec §6.1).
// Direction convention: content moving up (y decreasing) → next frame (dir 1);
// content moving left (x decreasing) → next collection (dir 1).

export type Axis = 'y' | 'x'
export type Dir = 1 | -1
export type Intent = { kind: 'frame'; dir: Dir } | { kind: 'collection'; dir: Dir }
export type ViewerIntent = Intent | { kind: 'home' } | { kind: 'end' }

export interface GestureConfig {
  viewportW: number
  viewportH: number
  reducedMotion: boolean
  /** Commit when |displacement| exceeds this share of the viewport dimension. */
  distanceRatio: 0.2
  /** Commit when release velocity exceeds this many px/ms. */
  velocity: 0.4
  /** Axis locks once movement exceeds this many px. */
  lockPx: 10
}

export const DEFAULT_GESTURE = { distanceRatio: 0.2, velocity: 0.4, lockPx: 10 } as const

/** Window used to measure release velocity. */
const VELOCITY_WINDOW_MS = 100

interface Sample {
  x: number
  y: number
  t: number
}

export type GestureState = 'idle' | 'tracking'

export class PointerGesture {
  private cfg: GestureConfig
  private origin: Sample | null = null
  private samples: Sample[] = []
  private axis: Axis | null = null

  constructor(cfg: GestureConfig) {
    this.cfg = cfg
  }

  get state(): GestureState {
    return this.origin ? 'tracking' : 'idle'
  }

  get lockedAxis(): Axis | null {
    return this.axis
  }

  start(x: number, y: number, t: number): void {
    this.origin = { x, y, t }
    this.samples = [{ x, y, t }]
    this.axis = null
  }

  move(x: number, y: number, t: number): { axis: Axis | null; offset: number } {
    const o = this.origin
    if (!o) return { axis: null, offset: 0 }
    this.record(x, y, t)
    const dx = x - o.x
    const dy = y - o.y
    if (this.axis === null) {
      const ax = Math.abs(dx)
      const ay = Math.abs(dy)
      if (Math.max(ax, ay) > this.cfg.lockPx) this.axis = ay >= ax ? 'y' : 'x'
    }
    if (this.axis === null) return { axis: null, offset: 0 }
    const offset = this.cfg.reducedMotion ? 0 : this.axis === 'y' ? dy : dx
    return { axis: this.axis, offset }
  }

  end(x: number, y: number, t: number): Intent | null {
    const o = this.origin
    if (!o) return null
    const dx = x - o.x
    const dy = y - o.y
    // Before the axis locks, only the axis with the larger displacement counts.
    const axis: Axis = this.axis ?? (Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x')
    const d = axis === 'y' ? dy : dx
    const ref = this.velocityRef(t)
    const dt = ref ? t - ref.t : 0
    const v = ref && dt > 0 ? ((axis === 'y' ? y - ref.y : x - ref.x) / dt) : 0
    this.cancel()

    if (d === 0) return null
    const span = axis === 'y' ? this.cfg.viewportH : this.cfg.viewportW
    const byDistance = Math.abs(d) > span * this.cfg.distanceRatio
    // Velocity only counts when it agrees with the displacement and the
    // pointer has actually travelled (filters tiny fast twitches).
    const byVelocity = Math.abs(d) > this.cfg.lockPx && v * Math.sign(d) > this.cfg.velocity
    if (!byDistance && !byVelocity) return null
    const dir: Dir = d < 0 ? 1 : -1
    return { kind: axis === 'y' ? 'frame' : 'collection', dir }
  }

  cancel(): void {
    this.origin = null
    this.samples = []
    this.axis = null
  }

  private record(x: number, y: number, t: number): void {
    this.samples.push({ x, y, t })
    // Keep only what the velocity window can use (plus one older sample).
    while (this.samples.length > 2 && (this.samples[1]?.t ?? t) < t - VELOCITY_WINDOW_MS) {
      this.samples.shift()
    }
  }

  /** Oldest sample inside the velocity window, else the latest earlier one. */
  private velocityRef(t: number): Sample | null {
    const earlier = this.samples.filter((s) => s.t < t)
    if (earlier.length === 0) return null
    const inWindow = earlier.find((s) => s.t >= t - VELOCITY_WINDOW_MS)
    return inWindow ?? earlier[earlier.length - 1] ?? null
  }
}

export interface WheelSample {
  deltaX: number
  deltaY: number
  /** 0 = pixels, 1 = lines, 2 = pages (WheelEvent.deltaMode). */
  deltaMode: 0 | 1 | 2
  t: number
}

export class WheelAccumulator {
  private threshold: number
  private lockMs: number
  private lockUntil = -Infinity
  private accX = 0
  private accY = 0

  constructor(opts?: { threshold?: 60; lockMs?: 500 }) {
    this.threshold = opts?.threshold ?? 60
    this.lockMs = opts?.lockMs ?? 500
  }

  /** True while wheel input is swallowed (the rolling post-trigger lock). */
  locked(t: number): boolean {
    return t < this.lockUntil
  }

  push(e: WheelSample): Intent | null {
    // Rolling lock: any event inside it is swallowed (not accumulated) and
    // extends it, so one flick plus its momentum pages at most once until a
    // quiet gap of lockMs.
    if (e.t < this.lockUntil) {
      this.lockUntil = e.t + this.lockMs
      return null
    }

    // Each event counts only on its dominant axis, so drift on the minor
    // axis never accumulates into a (heavy) collection change.
    const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX)
    const d = vertical ? e.deltaY : e.deltaX
    if (d === 0) return null

    if (e.deltaMode !== 0) {
      // Line/page mode: one notch flips immediately.
      return this.trigger(vertical ? 'frame' : 'collection', d, e.t)
    }

    if (vertical) {
      this.accY = accumulate(this.accY, d)
      if (Math.abs(this.accY) >= this.threshold) return this.trigger('frame', this.accY, e.t)
    } else {
      this.accX = accumulate(this.accX, d)
      if (Math.abs(this.accX) >= this.threshold) return this.trigger('collection', this.accX, e.t)
    }
    return null
  }

  private trigger(kind: Intent['kind'], d: number, t: number): Intent {
    this.lockUntil = t + this.lockMs
    this.accX = 0
    this.accY = 0
    return { kind, dir: d > 0 ? 1 : -1 }
  }
}

/** A reversal of direction restarts accumulation instead of cancelling out. */
function accumulate(acc: number, delta: number): number {
  if (delta === 0) return acc
  return Math.sign(acc) === -Math.sign(delta) ? delta : acc + delta
}

export function keyIntent(key: string, shift: boolean): ViewerIntent | null {
  switch (key) {
    case 'ArrowDown':
    case 'PageDown':
      return { kind: 'frame', dir: 1 }
    case 'ArrowUp':
    case 'PageUp':
      return { kind: 'frame', dir: -1 }
    case ' ':
    case 'Spacebar':
      return { kind: 'frame', dir: shift ? -1 : 1 }
    case 'ArrowRight':
      return { kind: 'collection', dir: 1 }
    case 'ArrowLeft':
      return { kind: 'collection', dir: -1 }
    case 'Home':
      return { kind: 'home' }
    case 'End':
      return { kind: 'end' }
    default:
      return null
  }
}
