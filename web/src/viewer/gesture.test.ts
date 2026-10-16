import { describe, expect, it } from 'vitest'
import { PointerGesture, WheelAccumulator, keyIntent, type GestureConfig } from './gesture'

const cfg = (over: Partial<GestureConfig> = {}): GestureConfig => ({
  viewportW: 400,
  viewportH: 800,
  reducedMotion: false,
  distanceRatio: 0.2,
  velocity: 0.4,
  lockPx: 10,
  ...over,
})

describe('PointerGesture', () => {
  it('commits a frame intent when vertical distance exceeds 20% of viewport height', () => {
    const g = new PointerGesture(cfg())
    g.start(200, 600, 0)
    g.move(200, 500, 500)
    g.move(200, 430, 1000) // 170px up, slow
    expect(g.end(200, 430, 1500)).toEqual({ kind: 'frame', dir: 1 })
  })

  it('commits the previous frame when dragging down past the threshold', () => {
    const g = new PointerGesture(cfg())
    g.start(200, 100, 0)
    g.move(200, 300, 1000)
    expect(g.end(200, 300, 2000)).toEqual({ kind: 'frame', dir: -1 })
  })

  it('commits on velocity alone even when distance is short', () => {
    const g = new PointerGesture(cfg())
    g.start(200, 400, 0)
    g.move(200, 380, 20)
    g.move(200, 350, 50) // 50px in 50ms = 1 px/ms
    expect(g.end(200, 350, 50)).toEqual({ kind: 'frame', dir: 1 })
  })

  it('springs back (null) when neither distance nor velocity is reached', () => {
    const g = new PointerGesture(cfg())
    g.start(200, 400, 0)
    g.move(200, 350, 500)
    expect(g.end(200, 350, 1000)).toBeNull()
  })

  it('uses viewport width for horizontal swipes; left swipe is next collection', () => {
    const g = new PointerGesture(cfg())
    g.start(300, 400, 0)
    g.move(210, 400, 1000) // 90px > 80px (20% of 400)
    expect(g.end(210, 400, 2000)).toEqual({ kind: 'collection', dir: 1 })
    const g2 = new PointerGesture(cfg())
    g2.start(100, 400, 0)
    g2.move(190, 400, 1000)
    expect(g2.end(190, 400, 2000)).toEqual({ kind: 'collection', dir: -1 })
  })

  it('does not lock an axis before 10px of movement', () => {
    const g = new PointerGesture(cfg())
    g.start(0, 0, 0)
    expect(g.move(5, 3, 10)).toEqual({ axis: null, offset: 0 })
  })

  it('locks the axis after 12px horizontal movement; later vertical movement is ignored', () => {
    const g = new PointerGesture(cfg())
    g.start(200, 400, 0)
    expect(g.move(188, 400, 100)).toEqual({ axis: 'x', offset: -12 })
    const r = g.move(185, 100, 1000)
    expect(r.axis).toBe('x')
    expect(r.offset).toBe(-15)
    expect(g.end(185, 100, 2000)).toBeNull()
  })

  it('reports the follow-finger offset on the locked axis', () => {
    const g = new PointerGesture(cfg())
    g.start(200, 400, 0)
    expect(g.move(201, 380, 100)).toEqual({ axis: 'y', offset: -20 })
  })

  it('keeps offset at 0 with reduced motion but still commits', () => {
    const g = new PointerGesture(cfg({ reducedMotion: true }))
    g.start(200, 600, 0)
    expect(g.move(200, 500, 500)).toEqual({ axis: 'y', offset: 0 })
    expect(g.move(200, 300, 1000)).toEqual({ axis: 'y', offset: 0 })
    expect(g.end(200, 300, 1500)).toEqual({ kind: 'frame', dir: 1 })
  })

  it('without a locked axis, end looks only at the larger axis', () => {
    const g = new PointerGesture(cfg())
    g.start(200, 400, 0)
    // jump straight to end: dx=-100 (>80 width threshold), dy=-120 (<160 height threshold)
    expect(g.end(100, 280, 2000)).toBeNull()
  })

  it('does not treat a tiny fast twitch as a swipe', () => {
    const g = new PointerGesture(cfg())
    g.start(200, 400, 0)
    g.move(200, 395, 2)
    expect(g.end(200, 395, 4)).toBeNull()
  })

  it('cancel resets the gesture', () => {
    const g = new PointerGesture(cfg())
    g.start(200, 600, 0)
    g.move(200, 300, 100)
    g.cancel()
    expect(g.end(200, 300, 200)).toBeNull()
    expect(g.move(200, 100, 300)).toEqual({ axis: null, offset: 0 })
  })
})

describe('WheelAccumulator', () => {
  it('20 consecutive deltaY=30 events at 16ms spacing produce exactly 1 intent', () => {
    const w = new WheelAccumulator()
    const intents = []
    for (let i = 0; i < 20; i++) {
      const r = w.push({ deltaX: 0, deltaY: 30, deltaMode: 0, t: i * 16 })
      if (r) intents.push(r)
    }
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
  })

  it('does not trigger below 60px', () => {
    const w = new WheelAccumulator()
    expect(w.push({ deltaX: 0, deltaY: 30, deltaMode: 0, t: 0 })).toBeNull()
    expect(w.push({ deltaX: 0, deltaY: 29, deltaMode: 0, t: 16 })).toBeNull()
    expect(w.push({ deltaX: 0, deltaY: 1, deltaMode: 0, t: 32 })).toEqual({ kind: 'frame', dir: 1 })
  })

  it('triggers again after the lock; events inside the lock are not accumulated', () => {
    const w = new WheelAccumulator()
    expect(w.push({ deltaX: 0, deltaY: 60, deltaMode: 0, t: 0 })).toEqual({ kind: 'frame', dir: 1 })
    expect(w.push({ deltaX: 0, deltaY: 200, deltaMode: 0, t: 499 })).toBeNull()
    // accumulation restarts from 0 after the lock: 200 swallowed above must not count
    expect(w.push({ deltaX: 0, deltaY: -30, deltaMode: 0, t: 500 })).toBeNull()
    expect(w.push({ deltaX: 0, deltaY: -30, deltaMode: 0, t: 516 })).toEqual({ kind: 'frame', dir: -1 })
  })

  it('deltaMode 1 (lines) triggers on a single notch', () => {
    const w = new WheelAccumulator()
    expect(w.push({ deltaX: 0, deltaY: 3, deltaMode: 1, t: 0 })).toEqual({ kind: 'frame', dir: 1 })
    expect(w.push({ deltaX: 0, deltaY: 3, deltaMode: 1, t: 100 })).toBeNull()
    expect(w.push({ deltaX: 0, deltaY: -3, deltaMode: 1, t: 600 })).toEqual({ kind: 'frame', dir: -1 })
  })

  it('deltaMode 2 (pages) triggers on a single notch', () => {
    const w = new WheelAccumulator()
    expect(w.push({ deltaX: 0, deltaY: 1, deltaMode: 2, t: 0 })).toEqual({ kind: 'frame', dir: 1 })
  })

  it('accumulates deltaX into collection intents', () => {
    const w = new WheelAccumulator()
    expect(w.push({ deltaX: 40, deltaY: 0, deltaMode: 0, t: 0 })).toBeNull()
    expect(w.push({ deltaX: 40, deltaY: 0, deltaMode: 0, t: 16 })).toEqual({ kind: 'collection', dir: 1 })
    const w2 = new WheelAccumulator()
    expect(w2.push({ deltaX: -80, deltaY: 0, deltaMode: 0, t: 0 })).toEqual({ kind: 'collection', dir: -1 })
  })

  it('respects custom threshold and lock', () => {
    const w = new WheelAccumulator({ threshold: 60, lockMs: 500 })
    expect(w.push({ deltaX: 0, deltaY: 60, deltaMode: 0, t: 0 })).not.toBeNull()
  })
})

describe('keyIntent', () => {
  it.each([
    ['ArrowDown', false, { kind: 'frame', dir: 1 }],
    ['PageDown', false, { kind: 'frame', dir: 1 }],
    [' ', false, { kind: 'frame', dir: 1 }],
    ['ArrowUp', false, { kind: 'frame', dir: -1 }],
    ['PageUp', false, { kind: 'frame', dir: -1 }],
    [' ', true, { kind: 'frame', dir: -1 }],
    ['ArrowRight', false, { kind: 'collection', dir: 1 }],
    ['ArrowLeft', false, { kind: 'collection', dir: -1 }],
    ['Home', false, { kind: 'home' }],
    ['End', false, { kind: 'end' }],
  ] as const)('%s (shift=%s)', (key, shift, expected) => {
    expect(keyIntent(key, shift)).toEqual(expected)
  })

  it('returns null for unmapped keys', () => {
    expect(keyIntent('a', false)).toBeNull()
    expect(keyIntent('Enter', false)).toBeNull()
    expect(keyIntent('i', false)).toBeNull()
  })
})
