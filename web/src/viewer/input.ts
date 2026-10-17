// Binds DOM input (Pointer Events, wheel, keyboard) to the gesture state machine.
// The component sets `touch-action: none` on `el`.

import {
  DEFAULT_GESTURE,
  PointerGesture,
  WheelAccumulator,
  keyIntent,
  type Axis,
  type Dir,
  type ViewerIntent,
} from './gesture'

export interface InputHandlers {
  intent(i: ViewerIntent): void
  /** Follow-finger offset on the locked axis. Called with 0 on spring-back or cancel. */
  drag(axis: Axis, offset: number): void
  /**
   * Single tap (touch, pen or mouse). It fires immediately, so the first tap
   * of a double tap also fires `tap`; the edge toggle it drives is idempotent
   * across the pair (toggle + toggle), so this is accepted.
   */
  tap(pointerType: string): void
  doubleTap(pointerType: string): void
  /**
   * Swipe up from the bottom edge (touch only): the info drawer's pull, in px,
   * negative while it rises with the finger. 0 on spring-back, cancel or before
   * the `info` intent that opens it.
   */
  sheet?(offset: number): void
  /**
   * Keys the viewer handles beyond navigation (i, f, Escape). Called after the
   * editable-target check and before navigation; return true when handled, so
   * the key is preventDefault'ed and goes no further.
   */
  key?(e: KeyboardEvent): boolean
}

/**
 * Inner vertical scroller of the current frame (a stacked `pair` frame on
 * narrow portrait screens). The viewer drives it itself: `el` has
 * `touch-action: none`, so the browser never pans it natively.
 *
 * Contract for the implementer (Task 5):
 * - `canScroll(dir)`: true when the container can still scroll forward
 *   (`dir = 1`, scrollTop < scrollHeight - clientHeight) or backward
 *   (`dir = -1`, scrollTop > 0). Use a 1px tolerance for fractional scrollTop.
 * - `scrollBy(dy)`: scroll by `dy` CSS px (positive = forward, i.e. content
 *   moves up), clamped to the container's range, synchronously and without
 *   smooth behaviour. Return the unconsumed residual `dy - actuallyScrolled`
 *   (0 when fully consumed; equal to `dy` at the boundary).
 *
 * Input routing:
 * - Touch/pen/mouse drag on the y axis scrolls inner first; only the residual
 *   past the boundary moves the frame (`drag`). A frame intent fires if the
 *   gesture started with inner already at the boundary (normal distance or
 *   velocity rules), or once the residual exceeds the distance threshold.
 * - Wheel deltas feed inner first. While inner consumes, nothing accumulates
 *   for the frame (the residual of the event that hits the boundary is
 *   dropped). Paging needs a further scroll after a quiet gap of >= 200ms.
 * - Frame keys scroll inner by ±0.9 viewport heights and page only once inner
 *   is at the boundary in that direction.
 * - Horizontal input never goes through inner.
 */
export interface InnerScroll {
  canScroll(dir: Dir): boolean
  scrollBy(dy: number): number
}

export interface InputConfig {
  reducedMotion: boolean
  /** Viewport size used for distance thresholds; defaults to window.inner*. */
  viewport?: () => { w: number; h: number }
  /** Clock in ms; defaults to performance.now(). */
  now?: () => number
  /** Inner scroller of the current frame, if any. Read on every event, so a getter may swap it. */
  inner?: InnerScroll
}

export const TAP_MAX_PX = 10
export const TAP_MAX_MS = 250
export const DOUBLE_TAP_MS = 300
/** A touch that starts this close to the bottom edge and moves up pulls the info drawer. */
export const SHEET_EDGE_PX = 28
/** The drawer is at most 60% of the viewport tall; release past 30% of that opens it. */
const SHEET_HEIGHT_RATIO = 0.6
const SHEET_COMMIT_RATIO = 0.3
/** Pixels per line for `deltaMode = 1` wheel events routed to inner. */
const LINE_PX = 40
/** Keyboard and page-mode wheel scroll inner by this share of the viewport height. */
const KEY_PAGE_RATIO = 0.9

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
/** Controls that own Space/Enter. */
const INTERACTIVE = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'summary',
  'video[controls]',
  'audio[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  ...[
    'button',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'checkbox',
    'switch',
    'radio',
    'slider',
    'spinbutton',
    'combobox',
    'tab',
  ].map((r) => `[role=${r}]`),
].join(', ')
/** Composite widgets that own the arrow keys. */
const ARROW_OWNERS = ['listbox', 'tablist', 'radiogroup', 'menubar', 'menu', 'slider', 'grid', 'tree']
  .map((r) => `[role=${r}]`)
  .join(', ')
/** Wheel: after inner stops consuming, frame accumulation needs this quiet gap ("a further scroll"). */
const INNER_QUIET_MS = 200
/** Presses here never start a gesture or count as a tap. */
const NO_GESTURE = `${INTERACTIVE}, label, [data-no-gesture]`
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

function closestEl(t: EventTarget | null, sel: string): Element | null {
  return t instanceof Element ? t.closest(sel) : null
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (t instanceof HTMLElement && t.isContentEditable) return true
  return closestEl(t, EDITABLE) !== null
}

export function bindInputs(el: HTMLElement, handlers: InputHandlers, cfg: InputConfig): () => void {
  const now = cfg.now ?? (() => performance.now())
  const viewport = cfg.viewport ?? (() => ({ w: window.innerWidth, h: window.innerHeight }))
  const threshold = (h: number) => h * DEFAULT_GESTURE.distanceRatio

  const wheelAcc = new WheelAccumulator()

  // --- pointer state ---
  const active = new Set<number>() // every pointer currently down that started on el
  let multi = false // a second pointer went down; suppress until all are up
  let gesture: PointerGesture | null = null
  let pointerId: number | null = null
  let downX = 0
  let downY = 0
  let downT = 0
  let maxDist = 0
  let dragAxis: Axis | null = null
  let lastTapT = -Infinity
  let downType = ''
  let fromBottom = false // touch started in the bottom SHEET_EDGE_PX
  let sheet = false // this gesture pulls the info drawer instead of paging
  // inner-scroll routing for the current y gesture
  let inner: InnerScroll | undefined
  let lastY = 0
  let residual = 0 // forward-positive frame displacement past inner's boundary
  let innerMoved = false

  const resetGesture = () => {
    gesture?.cancel()
    gesture = null
    pointerId = null
    dragAxis = null
    fromBottom = false
    sheet = false
    inner = undefined
    residual = 0
    innerMoved = false
  }

  /** Abort the current gesture and spring the frame back. */
  const cancelGesture = () => {
    const axis = dragAxis
    const wasSheet = sheet
    resetGesture()
    if (wasSheet) handlers.sheet?.(0)
    else if (axis !== null) handlers.drag(axis, 0)
  }

  /** Route a forward-positive vertical step through inner; returns the frame offset. */
  const stepInner = (s: number, scroller: InnerScroll): number => {
    let rest = s
    if (residual !== 0 && Math.sign(rest) === -Math.sign(residual)) {
      // Moving back: first undo the frame displacement, then scroll inner.
      const undo = Math.sign(rest) * Math.min(Math.abs(rest), Math.abs(residual))
      residual += undo
      rest -= undo
    }
    if (rest !== 0) {
      if (residual !== 0) {
        residual += rest // already past the boundary in this direction
      } else {
        const left = scroller.scrollBy(rest)
        if (left !== rest) innerMoved = true
        residual += left
      }
    }
    return cfg.reducedMotion || residual === 0 ? 0 : -residual
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerId === pointerId) cancelGesture() // stale gesture: its release never arrived
    if (e.isPrimary) {
      // A primary pointer means no other contact of its type is down: drop lost releases.
      active.clear()
      multi = false
    }
    active.add(e.pointerId)
    if (active.size > 1) {
      multi = true
      cancelGesture()
      return
    }
    if (multi) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const hit = closestEl(e.target, NO_GESTURE)
    if (hit && hit !== el && el.contains(hit)) return

    const vp = viewport()
    gesture = new PointerGesture({ viewportW: vp.w, viewportH: vp.h, reducedMotion: cfg.reducedMotion, ...DEFAULT_GESTURE })
    pointerId = e.pointerId
    downX = e.clientX
    downY = e.clientY
    downT = now()
    downType = e.pointerType
    fromBottom = e.pointerType === 'touch' && downY >= vp.h - SHEET_EDGE_PX
    maxDist = 0
    lastY = downY
    gesture.start(downX, downY, downT)
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!gesture || e.pointerId !== pointerId) return
    maxDist = Math.max(maxDist, Math.hypot(e.clientX - downX, e.clientY - downY))
    const r = gesture.move(e.clientX, e.clientY, now())
    if (r.axis === null) return
    if (dragAxis === null) {
      // Axis just locked: capture now, so plain presses never capture (clicks stay on their targets).
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // best-effort; window listeners still see the release
      }
      // Decided as the axis locks: up from the bottom edge pulls the info drawer.
      sheet = fromBottom && r.axis === 'y' && e.clientY < downY
      if (r.axis === 'y' && !sheet) inner = cfg.inner
    }
    dragAxis = r.axis
    if (sheet) {
      handlers.sheet?.(cfg.reducedMotion ? 0 : Math.min(0, e.clientY - downY))
      return
    }
    if (r.axis === 'y' && inner) {
      const offset = stepInner(lastY - e.clientY, inner)
      lastY = e.clientY
      handlers.drag('y', offset)
      return
    }
    handlers.drag(r.axis, r.offset)
  }

  const endPointer = (e: PointerEvent) => {
    active.delete(e.pointerId)
    if (active.size === 0) multi = false
  }

  const onPointerUp = (e: PointerEvent) => {
    const wasMulti = multi
    endPointer(e)
    if (!gesture || e.pointerId !== pointerId) return
    const t = now()
    maxDist = Math.max(maxDist, Math.hypot(e.clientX - downX, e.clientY - downY))
    let intent: ViewerIntent | null = gesture.end(e.clientX, e.clientY, t)
    if (sheet) {
      const pull = downY - e.clientY
      const commit = viewport().h * SHEET_HEIGHT_RATIO * SHEET_COMMIT_RATIO
      intent = pull > commit ? { kind: 'info' } : null
      if (!intent) handlers.sheet?.(0)
    } else if (inner && innerMoved) {
      // Inner scrolled during this gesture: page only on a residual past the threshold.
      intent = Math.abs(residual) > threshold(viewport().h) ? { kind: 'frame', dir: residual > 0 ? 1 : -1 } : null
    }
    const axis = sheet ? null : dragAxis
    const isTap = !wasMulti && maxDist < TAP_MAX_PX && t - downT < TAP_MAX_MS
    resetGesture()

    if (intent) handlers.intent(intent)
    else if (axis !== null) handlers.drag(axis, 0)

    if (isTap) {
      if (t - lastTapT <= DOUBLE_TAP_MS) {
        lastTapT = -Infinity
        handlers.doubleTap(downType)
      } else {
        lastTapT = t
        handlers.tap(downType)
      }
    }
  }

  const onPointerCancel = (e: PointerEvent) => {
    endPointer(e)
    if (e.pointerId === pointerId) cancelGesture()
  }

  /**
   * Only el losing a capture we took counts. Touch implicitly captures to the
   * pointerdown target (usually the <img>); our setPointerCapture moves it to
   * el and fires a bubbling lostpointercapture on that child, which must not
   * cancel. The pointer may still be down, so `active` is left to up/cancel.
   */
  const onLostCapture = (e: PointerEvent) => {
    if (e.target !== el || dragAxis === null || e.pointerId !== pointerId) return
    cancelGesture()
  }

  const onBlur = () => {
    active.clear()
    multi = false
    cancelGesture()
  }

  // --- wheel ---
  let lastWheelT = -Infinity
  // Inner consumed wheel input recently: the frame accumulates nothing until a quiet gap.
  let innerHold = false

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const t = now()
    const gap = t - lastWheelT
    lastWheelT = t
    if (innerHold && gap >= INNER_QUIET_MS) innerHold = false
    const mode = e.deltaMode === 1 || e.deltaMode === 2 ? e.deltaMode : 0
    const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX) && e.deltaY !== 0
    const scroller = cfg.inner
    if (vertical && scroller) {
      const dir: Dir = e.deltaY > 0 ? 1 : -1
      if (!wheelAcc.locked(t) && scroller.canScroll(dir)) {
        const px = mode === 0 ? e.deltaY : mode === 1 ? e.deltaY * LINE_PX : dir * viewport().h * KEY_PAGE_RATIO
        if (scroller.scrollBy(px) !== px) {
          // Inner consumed input: momentum reaching the boundary must not page.
          innerHold = true
          wheelAcc.reset()
          return
        }
      }
      if (innerHold) return
    }
    const intent = wheelAcc.push({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: mode, t })
    if (intent) handlers.intent(intent)
  }

  // --- keyboard ---
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
    if (isEditableTarget(e.target)) return
    if ((e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') && closestEl(e.target, INTERACTIVE)) return
    if (ARROWS.has(e.key) && closestEl(e.target, ARROW_OWNERS)) return
    if (handlers.key?.(e)) {
      e.preventDefault()
      return
    }
    const intent = keyIntent(e.key, e.shiftKey)
    if (!intent) return
    e.preventDefault()
    const scroller = cfg.inner
    if (intent.kind === 'frame' && scroller?.canScroll(intent.dir)) {
      scroller.scrollBy(intent.dir * viewport().h * KEY_PAGE_RATIO)
      return
    }
    handlers.intent(intent)
  }

  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('lostpointercapture', onLostCapture)
  // Move/up/cancel on window: a release outside `el` (no capture yet) still ends the gesture.
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  window.addEventListener('blur', onBlur)
  el.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('keydown', onKeyDown)

  return () => {
    el.removeEventListener('pointerdown', onPointerDown)
    el.removeEventListener('lostpointercapture', onLostCapture)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerCancel)
    window.removeEventListener('blur', onBlur)
    el.removeEventListener('wheel', onWheel)
    window.removeEventListener('keydown', onKeyDown)
    resetGesture()
    active.clear()
  }
}
