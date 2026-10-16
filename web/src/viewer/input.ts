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
  tap(): void
  doubleTap(): void
}

export interface InputConfig {
  reducedMotion: boolean
  /** Viewport size used for distance thresholds; defaults to window.inner*. */
  viewport?: () => { w: number; h: number }
  /** Clock in ms; defaults to performance.now(). */
  now?: () => number
  /** True when inner content (e.g. a stacked `pair` frame) can still scroll in `dir`. Suppresses frame intents. */
  canScrollInner?: (dir: Dir) => boolean
}

export const TAP_MAX_PX = 10
export const TAP_MAX_MS = 250
export const DOUBLE_TAP_MS = 300

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false
  if (t instanceof HTMLElement && t.isContentEditable) return true
  return t.closest(EDITABLE) !== null
}

export function bindInputs(el: HTMLElement, handlers: InputHandlers, cfg: InputConfig): () => void {
  const now = cfg.now ?? (() => performance.now())
  const viewport = cfg.viewport ?? (() => ({ w: window.innerWidth, h: window.innerHeight }))
  const canScrollInner = (dir: Dir) => cfg.canScrollInner?.(dir) ?? false

  const wheelAcc = new WheelAccumulator()
  let gesture: PointerGesture | null = null
  let pointerId: number | null = null
  let downX = 0
  let downY = 0
  let downT = 0
  let dragAxis: Axis | null = null
  let innerScroll = false
  let lastTapT = -Infinity

  const resetPointer = () => {
    gesture?.cancel()
    gesture = null
    pointerId = null
    dragAxis = null
    innerScroll = false
  }

  const onPointerDown = (e: PointerEvent) => {
    if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return
    const vp = viewport()
    gesture = new PointerGesture({ viewportW: vp.w, viewportH: vp.h, reducedMotion: cfg.reducedMotion, ...DEFAULT_GESTURE })
    pointerId = e.pointerId
    downX = e.clientX
    downY = e.clientY
    downT = now()
    gesture.start(downX, downY, downT)
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // capture is best-effort
    }
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!gesture || e.pointerId !== pointerId) return
    const r = gesture.move(e.clientX, e.clientY, now())
    if (r.axis === null) return
    if (dragAxis === null && r.axis === 'y') {
      // Axis just locked vertically: inner scroll wins over frame paging.
      innerScroll = canScrollInner(e.clientY - downY < 0 ? 1 : -1)
    }
    dragAxis = r.axis
    if (!innerScroll) handlers.drag(r.axis, r.offset)
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!gesture || e.pointerId !== pointerId) return
    const t = now()
    const intent = gesture.end(e.clientX, e.clientY, t)
    const axis = dragAxis
    const suppressed =
      intent !== null && intent.kind === 'frame' && (innerScroll || canScrollInner(intent.dir))
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY)
    const isTap = moved < TAP_MAX_PX && t - downT < TAP_MAX_MS
    resetPointer()

    if (intent && !suppressed) {
      handlers.intent(intent)
    } else if (axis !== null) {
      handlers.drag(axis, 0)
    }

    if (isTap) {
      if (t - lastTapT <= DOUBLE_TAP_MS) {
        lastTapT = -Infinity
        handlers.doubleTap()
      } else {
        lastTapT = t
        handlers.tap()
      }
    }
  }

  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    const axis = dragAxis
    const wasInner = innerScroll
    resetPointer()
    if (axis !== null && !wasInner) handlers.drag(axis, 0)
  }

  const onWheel = (e: WheelEvent) => {
    const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX)
    if (vertical && e.deltaY !== 0 && canScrollInner(e.deltaY > 0 ? 1 : -1)) return // native inner scroll
    e.preventDefault()
    const mode = e.deltaMode === 1 || e.deltaMode === 2 ? e.deltaMode : 0
    const intent = wheelAcc.push({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: mode, t: now() })
    if (intent) handlers.intent(intent)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
    if (isEditableTarget(e.target)) return
    const intent = keyIntent(e.key, e.shiftKey)
    if (!intent) return
    if (intent.kind === 'frame' && canScrollInner(intent.dir)) return // let the browser scroll inner content
    e.preventDefault()
    handlers.intent(intent)
  }

  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('pointercancel', onPointerCancel)
  el.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('keydown', onKeyDown)

  return () => {
    el.removeEventListener('pointerdown', onPointerDown)
    el.removeEventListener('pointermove', onPointerMove)
    el.removeEventListener('pointerup', onPointerUp)
    el.removeEventListener('pointercancel', onPointerCancel)
    el.removeEventListener('wheel', onWheel)
    window.removeEventListener('keydown', onKeyDown)
    resetPointer()
  }
}
