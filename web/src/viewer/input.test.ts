import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { bindInputs, type InnerScroll, type InputHandlers } from './input'
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

function bind(inner?: InnerScroll, reducedMotion = false) {
  unbind = bindInputs(el, handlers, {
    reducedMotion,
    viewport: () => ({ w: 400, h: 800 }),
    now: () => now,
    inner,
  })
}

/** Fake scroll container: `pos` in [0, max], forward (dy > 0) increases pos. */
function fakeInner(max: number, pos = 0) {
  const state = { pos, calls: [] as number[] }
  const inner: InnerScroll = {
    canScroll: (dir) => (dir === 1 ? state.pos < max : state.pos > 0),
    scrollBy: (dy) => {
      state.calls.push(dy)
      const next = Math.min(max, Math.max(0, state.pos + dy))
      const used = next - state.pos
      state.pos = next
      return dy - used
    },
  }
  return { inner, state }
}

function touch(type: string, id: number, x: number, y: number) {
  pointer(type, x, y, { pointerId: id, pointerType: 'touch' })
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

  it('a press that wanders 40px and returns within 250ms is not a tap (max displacement)', () => {
    bind()
    pointer('pointerdown', 100, 100)
    now += 50
    pointer('pointermove', 140, 100)
    now += 50
    pointer('pointerup', 101, 100)
    expect(handlers.tap).not.toHaveBeenCalled()
  })

  it('a stuck pointer (lost pointerup) does not block the next press with the same id', () => {
    bind()
    pointer('pointerdown', 200, 600)
    now += 50
    pointer('pointermove', 200, 580) // axis locks, drag starts
    // release happened outside: no pointerup ever arrives
    now += 1000
    tapAt(100, 100)
    expect(handlers.tap).toHaveBeenCalledTimes(1)
    expect(handlers.drag).toHaveBeenCalledWith('y', 0)
  })

  it('lostpointercapture cancels the gesture', () => {
    bind()
    pointer('pointerdown', 200, 600)
    now += 100
    pointer('pointermove', 200, 300)
    pointer('lostpointercapture', 200, 300)
    now += 100
    pointer('pointerup', 200, 300)
    expect(intents).toEqual([])
    expect(handlers.drag).toHaveBeenLastCalledWith('y', 0)
  })

  it('a lostpointercapture bubbling from a child (implicit touch capture moving to el) does not cancel the drag', () => {
    bind()
    const img = document.createElement('img')
    el.appendChild(img)
    const fire = (type: string, y: number, target: EventTarget = img) =>
      target.dispatchEvent(new PointerEvent(type, { clientX: 200, clientY: y, pointerId: 1, pointerType: 'touch', bubbles: true }))
    fire('pointerdown', 600)
    now += 50
    fire('pointermove', 580) // axis locks; el.setPointerCapture moves capture off the img
    fire('lostpointercapture', 580) // fired on the img, bubbles to el
    now += 50
    fire('pointermove', 400, el)
    expect(handlers.drag).toHaveBeenLastCalledWith('y', -200)
    now += 400
    fire('pointerup', 400, el)
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
  })

  it('lostpointercapture on el before capture was taken is ignored', () => {
    bind()
    pointer('pointerdown', 200, 600)
    pointer('lostpointercapture', 200, 600)
    now += 50
    pointer('pointerup', 202, 600)
    expect(handlers.tap).toHaveBeenCalledTimes(1)
  })

  it('lostpointercapture keeps a still-down pointer active, so a second finger is still multi-touch', () => {
    bind()
    touch('pointerdown', 1, 200, 600)
    now += 50
    touch('pointermove', 1, 200, 580)
    touch('lostpointercapture', 1, 200, 580) // e.g. el re-rendered; finger 1 still down
    touch('pointerdown', 2, 200, 600)
    now += 50
    touch('pointermove', 2, 200, 300)
    now += 50
    touch('pointerup', 2, 200, 300)
    expect(intents).toEqual([])
    touch('pointerup', 1, 200, 580)
    now += 500
    touch('pointerdown', 3, 100, 100)
    now += 50
    touch('pointerup', 3, 100, 100)
    expect(handlers.tap).toHaveBeenCalledTimes(1)
  })

  it('captures the pointer only after the axis locks', () => {
    bind()
    const cap = vi.spyOn(el, 'setPointerCapture')
    pointer('pointerdown', 100, 100)
    expect(cap).not.toHaveBeenCalled()
    pointer('pointermove', 100, 105)
    expect(cap).not.toHaveBeenCalled()
    pointer('pointermove', 100, 120)
    expect(cap).toHaveBeenCalledWith(1)
  })

  it.each(['button', 'a', '[data-no-gesture]'])('ignores presses on %s inside the viewer', (sel) => {
    bind()
    const target =
      sel === 'button' ? document.createElement('button') : sel === 'a' ? document.createElement('a') : document.createElement('div')
    if (sel === 'a') target.setAttribute('href', '/')
    if (sel === '[data-no-gesture]') target.setAttribute('data-no-gesture', '')
    const child = document.createElement('span')
    target.appendChild(child)
    el.appendChild(target)
    const cap = vi.spyOn(el, 'setPointerCapture')
    const fire = (type: string, y: number) =>
      child.dispatchEvent(new PointerEvent(type, { clientX: 10, clientY: y, pointerId: 1, bubbles: true }))
    fire('pointerdown', 600)
    now += 50
    fire('pointermove', 300)
    fire('pointerup', 300)
    expect(handlers.tap).not.toHaveBeenCalled()
    expect(handlers.drag).not.toHaveBeenCalled()
    expect(intents).toEqual([])
    expect(cap).not.toHaveBeenCalled()
  })
})

describe('bindInputs: multi-touch', () => {
  it('a second finger cancels the swipe and springs back', () => {
    bind()
    touch('pointerdown', 1, 200, 600)
    now += 100
    touch('pointermove', 1, 200, 400)
    expect(handlers.drag).toHaveBeenLastCalledWith('y', -200)
    touch('pointerdown', 2, 250, 500)
    expect(handlers.drag).toHaveBeenLastCalledWith('y', 0)
    now += 100
    touch('pointermove', 1, 200, 200)
    touch('pointerup', 1, 200, 200)
    touch('pointerup', 2, 250, 500)
    expect(intents).toEqual([])
    expect(handlers.drag).toHaveBeenLastCalledWith('y', 0)
  })

  it('pinch taps are suppressed until all pointers are up', () => {
    bind()
    touch('pointerdown', 1, 100, 100)
    touch('pointerdown', 2, 200, 200)
    now += 50
    touch('pointerup', 1, 100, 100)
    // finger 2 still down: a new press is part of the multi-touch
    touch('pointerdown', 3, 100, 100)
    now += 50
    touch('pointerup', 3, 100, 100)
    touch('pointerup', 2, 200, 200)
    expect(handlers.tap).not.toHaveBeenCalled()
    expect(handlers.doubleTap).not.toHaveBeenCalled()
    // once everything is up, gestures work again
    now += 500
    touch('pointerdown', 4, 100, 100)
    now += 50
    touch('pointerup', 4, 100, 100)
    expect(handlers.tap).toHaveBeenCalledTimes(1)
  })

  it('a primary pointerdown clears pointers whose release was lost', () => {
    bind()
    touch('pointerdown', 1, 100, 100)
    touch('pointerdown', 2, 200, 200) // multi-touch; both releases get lost
    now += 1000
    pointer('pointerdown', 100, 100, { pointerId: 7, pointerType: 'touch', isPrimary: true })
    now += 50
    pointer('pointerup', 100, 100, { pointerId: 7, pointerType: 'touch', isPrimary: true })
    expect(handlers.tap).toHaveBeenCalledTimes(1)
  })
})

describe('bindInputs: inner scroll (stacked pair)', () => {
  it('touch drag scrolls inner first and no frame intent fires if the residual stays small', () => {
    const { inner, state } = fakeInner(300)
    bind(inner)
    touch('pointerdown', 1, 200, 700)
    now += 500
    touch('pointermove', 1, 200, 500) // 200 forward, all consumed
    expect(state.pos).toBe(200)
    expect(handlers.drag).toHaveBeenLastCalledWith('y', 0)
    now += 500
    touch('pointermove', 1, 200, 300) // 100 consumed, 100 residual
    expect(state.pos).toBe(300)
    expect(handlers.drag).toHaveBeenLastCalledWith('y', -100)
    now += 500
    touch('pointerup', 1, 200, 300) // total 400 > 160, but residual 100 < 160
    expect(intents).toEqual([])
    expect(handlers.drag).toHaveBeenLastCalledWith('y', 0)
  })

  it('pages once the residual past the boundary exceeds the threshold', () => {
    const { inner } = fakeInner(100)
    bind(inner)
    touch('pointerdown', 1, 200, 700)
    now += 500
    touch('pointermove', 1, 200, 430) // 100 consumed, 170 residual
    expect(handlers.drag).toHaveBeenLastCalledWith('y', -170)
    now += 500
    touch('pointerup', 1, 200, 430)
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
  })

  it('a fast flick pages when the gesture starts with inner already at the boundary', () => {
    const { inner, state } = fakeInner(300, 300)
    bind(inner)
    touch('pointerdown', 1, 200, 400)
    for (let t = 10; t <= 50; t += 10) {
      now += 10
      touch('pointermove', 1, 200, 400 - t)
    }
    touch('pointerup', 1, 200, 350) // 50px in 50ms
    expect(state.pos).toBe(300)
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
  })

  it('a fast flick that hits the boundary mid-gesture does not page', () => {
    const { inner } = fakeInner(20)
    bind(inner)
    touch('pointerdown', 1, 200, 400)
    for (let t = 10; t <= 50; t += 10) {
      now += 10
      touch('pointermove', 1, 200, 400 - t)
    }
    touch('pointerup', 1, 200, 350) // residual 30 < 160
    expect(intents).toEqual([])
  })

  it('dragging back first un-displaces the frame, then scrolls inner backward', () => {
    const { inner, state } = fakeInner(100, 100)
    bind(inner)
    touch('pointerdown', 1, 200, 500)
    now += 100
    touch('pointermove', 1, 200, 450) // at boundary: residual 50
    expect(handlers.drag).toHaveBeenLastCalledWith('y', -50)
    now += 100
    touch('pointermove', 1, 200, 530) // back 80: 50 undoes residual, 30 scrolls inner back
    expect(handlers.drag).toHaveBeenLastCalledWith('y', 0)
    expect(state.pos).toBe(70)
  })

  it('reduced motion keeps the residual drag offset at 0', () => {
    const { inner } = fakeInner(0)
    bind(inner, true)
    touch('pointerdown', 1, 200, 700)
    now += 100
    touch('pointermove', 1, 200, 400)
    expect(handlers.drag).toHaveBeenLastCalledWith('y', 0)
    now += 500
    touch('pointerup', 1, 200, 400)
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
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

  it('wheel deltas scroll inner first; nothing accumulates for the frame while inner consumes', () => {
    const { inner, state } = fakeInner(100)
    bind(inner)
    const e = wheel(80)
    expect(state.pos).toBe(80)
    expect(e.defaultPrevented).toBe(true)
    now += 16
    wheel(50) // 20 consumed, 30 residual discarded
    now += 16
    wheel(30) // at the boundary, no quiet gap yet
    now += 16
    wheel(30)
    expect(intents).toEqual([])
    now += 250 // quiet gap: "a further scroll"
    wheel(60)
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
  })

  it('trackpad momentum that reaches the bottom of inner gives 0 intents; a new flick after 300ms gives 1', () => {
    const { inner, state } = fakeInner(300)
    bind(inner)
    for (let i = 0; i < 94; i++) {
      wheel(Math.max(1, Math.round(40 * 0.96 ** i)))
      now += 16
    }
    expect(state.pos).toBe(300)
    expect(intents).toEqual([])
    now += 300
    for (let i = 0; i < 10; i++) {
      wheel(30)
      now += 16
    }
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
  })

  it('inner consuming a delta clears any stale frame accumulation', () => {
    const { inner } = fakeInner(100, 100)
    bind(inner)
    wheel(50) // at the bottom: accumulates 50
    now += 16
    wheel(-20) // inner scrolls back: resets
    now += 300
    wheel(20) // inner consumes back to the bottom
    now += 300
    wheel(30) // fresh accumulation: 30 < 60
    expect(intents).toEqual([])
  })

  it('swallowed momentum inside the lock does not scroll inner', () => {
    const { inner, state } = fakeInner(0)
    bind(inner)
    wheel(60)
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
    state.pos = 0
    const calls = state.calls.length
    now += 16
    wheel(-30)
    expect(state.calls.length).toBe(calls)
  })

  it('a line-mode notch scrolls inner instead of paging while inner can scroll', () => {
    const { inner, state } = fakeInner(500)
    bind(inner)
    wheel(3, 0, 1)
    expect(state.pos).toBeGreaterThan(0)
    expect(intents).toEqual([])
  })

  it('horizontal wheel is not routed through inner', () => {
    const { inner, state } = fakeInner(500)
    bind(inner)
    wheel(0, 100)
    expect(state.calls).toEqual([])
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

  it('keys scroll inner by 0.9 viewport heights and page only at the boundary', () => {
    const { inner, state } = fakeInner(1000)
    bind(inner)
    const e = key('ArrowDown')
    expect(state.calls).toEqual([720])
    expect(e.defaultPrevented).toBe(true)
    expect(intents).toEqual([])
    key('PageDown') // reaches 1000 (boundary) but still no page on this press
    expect(intents).toEqual([])
    key('ArrowDown')
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
    key(' ', document.body, true)
    expect(state.calls.at(-1)).toBe(-720)
    key('ArrowRight')
    expect(intents).toEqual([
      { kind: 'frame', dir: 1 },
      { kind: 'collection', dir: 1 },
    ])
  })

  it.each<[string, () => HTMLElement]>([
    ['button', () => document.createElement('button')],
    ['a[href]', () => Object.assign(document.createElement('a'), { href: '/' })],
    ['[role=menuitem]', () => {
      const d = document.createElement('div')
      d.setAttribute('role', 'menuitem')
      d.tabIndex = 0
      return d
    }],
    ['summary', () => document.createElement('summary')],
    ...['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio', 'link', 'combobox', 'spinbutton'].map(
      (role) =>
        [
          `[role=${role}]`,
          () => {
            const d = document.createElement('div')
            d.setAttribute('role', role)
            d.tabIndex = 0
            return d
          },
        ] as [string, () => HTMLElement],
    ),
    ['video[controls]', () => {
      const v = document.createElement('video')
      v.setAttribute('controls', '')
      return v
    }],
  ])('Space and Enter on a focused %s are left to the element', (_name, make) => {
    bind()
    const btn = make()
    document.body.appendChild(btn)
    const sp = key(' ', btn)
    const en = key('Enter', btn)
    expect(intents).toEqual([])
    expect(sp.defaultPrevented).toBe(false)
    expect(en.defaultPrevented).toBe(false)
    key('ArrowDown', btn) // arrows still page from a plain button
    expect(intents).toEqual([{ kind: 'frame', dir: 1 }])
  })

  it('Space and Enter on a [role=option] inside a [role=listbox] are left to it', () => {
    bind()
    const box = document.createElement('div')
    box.setAttribute('role', 'listbox')
    const opt = document.createElement('div')
    opt.setAttribute('role', 'option')
    opt.tabIndex = 0
    box.appendChild(opt)
    document.body.appendChild(box)
    expect(key(' ', opt).defaultPrevented).toBe(false)
    expect(key('Enter', opt).defaultPrevented).toBe(false)
    expect(key('ArrowDown', opt).defaultPrevented).toBe(false)
    expect(intents).toEqual([])
  })

  it.each(['menu', 'slider', 'listbox', 'tablist', 'radiogroup', 'menubar', 'grid', 'tree'])('arrow keys inside [role=%s] are left to it', (role) => {
    bind()
    const box = document.createElement('div')
    box.setAttribute('role', role)
    const item = document.createElement('div')
    item.tabIndex = 0
    box.appendChild(item)
    document.body.appendChild(box)
    const events = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].map((k) => key(k, item))
    expect(intents).toEqual([])
    expect(events.some((e) => e.defaultPrevented)).toBe(false)
  })

  it('unmapped keys are not prevented', () => {
    bind()
    expect(key('Tab').defaultPrevented).toBe(false)
    expect(key('i').defaultPrevented).toBe(false)
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
