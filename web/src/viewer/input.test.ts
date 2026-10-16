import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { bindInputs, type InputHandlers } from './input'
import type { ViewerIntent } from './gesture'

let now = 0
let el: HTMLElement
let unbind: () => void
let intents: ViewerIntent[]
let handlers: {
  intent: InputHandlers['intent']
  drag: Mock<InputHandlers['drag']>
  tap: Mock<InputHandlers['tap']>
  doubleTap: Mock<InputHandlers['doubleTap']>
}

function pointer(type: string, x: number, y: number, extra: PointerEventInit = {}) {
  el.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, cancelable: true, ...extra }),
  )
}

function tapAt(x: number, y: number, duration = 50) {
  pointer('pointerdown', x, y)
  now += duration
  pointer('pointerup', x + 2, y + 2)
}

function wheel(deltaY: number, deltaX = 0, deltaMode = 0) {
  const e = new WheelEvent('wheel', { deltaX, deltaY, deltaMode, bubbles: true, cancelable: true })
  el.dispatchEvent(e)
  return e
}

function key(k: string, target: EventTarget = document.body, shiftKey = false) {
  const e = new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

function bind(canScrollInner?: (dir: 1 | -1) => boolean) {
  unbind = bindInputs(el, handlers, {
    reducedMotion: false,
    viewport: () => ({ w: 400, h: 800 }),
    now: () => now,
    canScrollInner,
  })
}

beforeEach(() => {
  now = 1000
  el = document.createElement('div')
  document.body.appendChild(el)
  intents = []
  handlers = {
    intent: (i: ViewerIntent) => intents.push(i),
    drag: vi.fn<InputHandlers['drag']>(),
    tap: vi.fn<InputHandlers['tap']>(),
    doubleTap: vi.fn<InputHandlers['doubleTap']>(),
  }
})

afterEach(() => {
  unbind?.()
  el.remove()
  document.body.innerHTML = ''
})

describe('bindInputs: pointer', () => {
  it('emits drag offsets and a frame intent for an upward swipe', () => {
    bind()
    pointer('pointerdown', 200, 600)
    now += 500
    pointer('pointermove', 200, 400)
    now += 500
    pointer('pointerup', 200, 400)
    expect(handlers.drag).toHaveBeenCalledWith('y', -200)
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
    expect(handlers.tap).not.toHaveBeenCalled()
  })

  it('springs back with drag offset 0 when below threshold', () => {
    bind()
    pointer('pointerdown', 200, 400)
    now += 500
    pointer('pointermove', 200, 350)
    now += 500
    pointer('pointerup', 200, 350)
    expect(intents).toEqual([])
    expect(handlers.drag).toHaveBeenLastCalledWith('y', 0)
  })

  it('a short, still press is a tap', () => {
    bind()
    tapAt(100, 100)
    expect(handlers.tap).toHaveBeenCalledTimes(1)
    expect(handlers.doubleTap).not.toHaveBeenCalled()
  })

  it('a press longer than 250ms is not a tap', () => {
    bind()
    tapAt(100, 100, 300)
    expect(handlers.tap).not.toHaveBeenCalled()
  })

  it('a press that moves 10px or more is not a tap', () => {
    bind()
    pointer('pointerdown', 100, 100)
    now += 50
    pointer('pointerup', 112, 100)
    expect(handlers.tap).not.toHaveBeenCalled()
  })

  it('two taps within 300ms are a double tap', () => {
    bind()
    tapAt(100, 100)
    now += 150
    tapAt(102, 101)
    expect(handlers.tap).toHaveBeenCalledTimes(1)
    expect(handlers.doubleTap).toHaveBeenCalledTimes(1)
  })

  it('two taps further than 300ms apart are two single taps', () => {
    bind()
    tapAt(100, 100)
    now += 400
    tapAt(100, 100)
    expect(handlers.tap).toHaveBeenCalledTimes(2)
    expect(handlers.doubleTap).not.toHaveBeenCalled()
  })

  it('a third quick tap after a double tap starts a new sequence', () => {
    bind()
    tapAt(100, 100)
    now += 100
    tapAt(100, 100)
    now += 100
    tapAt(100, 100)
    expect(handlers.doubleTap).toHaveBeenCalledTimes(1)
    expect(handlers.tap).toHaveBeenCalledTimes(2)
  })

  it('suppresses frame intent and drag when inner content can still scroll', () => {
    const can = vi.fn((_dir: 1 | -1) => true)
    bind(can)
    pointer('pointerdown', 200, 600)
    now += 500
    pointer('pointermove', 200, 300)
    now += 500
    pointer('pointerup', 200, 300)
    expect(intents).toEqual([])
    expect(can).toHaveBeenCalledWith(1)
    expect(handlers.drag).not.toHaveBeenCalledWith('y', -300)
  })

  it('pointercancel resets without an intent', () => {
    bind()
    pointer('pointerdown', 200, 600)
    now += 100
    pointer('pointermove', 200, 300)
    pointer('pointercancel', 200, 300)
    pointer('pointerup', 200, 300)
    expect(intents).toEqual([])
    expect(handlers.drag).toHaveBeenLastCalledWith('y', 0)
  })
})

describe('bindInputs: wheel', () => {
  it('prevents default and accumulates into one intent', () => {
    bind()
    const events: WheelEvent[] = []
    for (let i = 0; i < 20; i++) {
      events.push(wheel(30))
      now += 16
    }
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
    expect(events.every((e) => e.defaultPrevented)).toBe(true)
  })

  it('lets the wheel scroll inner content natively and produces no frame intent', () => {
    bind(() => true)
    const e = wheel(100)
    expect(intents).toEqual([])
    expect(e.defaultPrevented).toBe(false)
  })

  it('horizontal wheel is not affected by canScrollInner', () => {
    bind(() => true)
    wheel(0, 100)
    expect(intents).toEqual([{ kind: 'collection', dir: 1 }])
  })
})

describe('bindInputs: keyboard', () => {
  it('maps keys on window to intents and prevents default', () => {
    bind()
    const e = key(' ')
    key('ArrowLeft')
    key('End')
    key(' ', document.body, true)
    expect(intents).toEqual([
      { kind: 'frame', dir: 1 },
      { kind: 'collection', dir: -1 },
      { kind: 'end' },
      { kind: 'frame', dir: -1 },
    ])
    expect(e.defaultPrevented).toBe(true)
  })

  it('ignores keys from input, textarea and contenteditable', () => {
    bind()
    const input = document.createElement('input')
    const ta = document.createElement('textarea')
    const ce = document.createElement('div')
    ce.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    ce.appendChild(inner)
    document.body.append(input, ta, ce)
    key('ArrowDown', input)
    key(' ', ta)
    key('ArrowRight', ce)
    key('ArrowRight', inner)
    expect(intents).toEqual([])
  })

  it('suppresses keyboard frame intents while inner content can scroll', () => {
    bind(() => true)
    const e = key('ArrowDown')
    key('ArrowRight')
    expect(intents).toEqual([{ kind: 'collection', dir: 1 }])
    expect(e.defaultPrevented).toBe(false)
  })

  it('unbinding removes all listeners', () => {
    bind()
    unbind()
    key('ArrowDown')
    wheel(100)
    tapAt(10, 10)
    expect(intents).toEqual([])
    expect(handlers.tap).not.toHaveBeenCalled()
  })
})
