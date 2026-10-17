// Edge visibility for the viewer stage (spec §5.2): a pointer within 72px of
// an edge reveals it, 2s without pointer movement hides every edge and the
// cursor, pins (open menu, info layer, focused edge) hold them, a touch tap
// toggles all four, and flashTop shows the top edge briefly.
import { reactive } from 'vue'

export type Edge = 'top' | 'left' | 'right' | 'bottom'
export type EdgeVisibility = Record<Edge, boolean>

export const EDGE_PX = 72
export const IDLE_MS = 2000
const EDGES: readonly Edge[] = ['top', 'left', 'right', 'bottom']

export interface Edges {
  visible: EdgeVisibility
  pin(reason: string): void
  unpin(reason: string): void
  pinned(reason: string): boolean
  toggleAll(): void
  flashTop(ms: number): void
  /** Attach to the stage when it was not available at creation. */
  attach(el: HTMLElement): void
  stop(): void
}

function edgeOf(t: EventTarget | null): Edge | null {
  const v = t instanceof Element ? t.closest('[data-edge]')?.getAttribute('data-edge') : null
  return v && (EDGES as readonly string[]).includes(v) ? (v as Edge) : null
}

export function useEdges(initial?: HTMLElement): Edges {
  const visible = reactive<EdgeVisibility>({ top: false, left: false, right: false, bottom: false })
  const pins = new Set<string>()
  let el: HTMLElement | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let flashTimer: ReturnType<typeof setTimeout> | null = null

  const setIdle = (on: boolean) => {
    if (!el) return
    if (on) el.setAttribute('data-idle', '')
    else el.removeAttribute('data-idle')
  }

  function hideAll() {
    if (pins.size > 0) return
    for (const e of EDGES) visible[e] = false
    setIdle(true)
  }

  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      hideAll()
    }, IDLE_MS)
  }

  const onMove = (e: PointerEvent) => {
    // Touch moves are swipes; touch reveals edges with a tap instead.
    if (!el || e.pointerType === 'touch') return
    const r = el.getBoundingClientRect()
    const x = e.clientX
    const y = e.clientY
    const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    const over = edgeOf(e.target)
    const near: EdgeVisibility = {
      top: inside && y - r.top < EDGE_PX,
      bottom: inside && r.bottom - y < EDGE_PX,
      left: inside && x - r.left < EDGE_PX,
      right: inside && r.right - x < EDGE_PX,
    }
    for (const edge of EDGES) {
      if (near[edge] || over === edge) visible[edge] = true
      else if (!pins.has(`focus:${edge}`) && pins.size === 0) visible[edge] = false
    }
    setIdle(false)
    armIdle()
  }

  const onFocusIn = (e: FocusEvent) => {
    const edge = edgeOf(e.target)
    if (!edge) return
    visible[edge] = true
    setIdle(false)
    pin(`focus:${edge}`)
  }

  const onFocusOut = (e: FocusEvent) => {
    const edge = edgeOf(e.target)
    if (!edge) return
    // Focus moving within the same edge keeps it pinned.
    if (edgeOf(e.relatedTarget) === edge) return
    unpin(`focus:${edge}`)
  }

  function pin(reason: string) {
    pins.add(reason)
    setIdle(false)
  }

  function unpin(reason: string) {
    if (!pins.delete(reason)) return
    if (pins.size === 0) armIdle()
  }

  function toggleAll() {
    const show = !EDGES.some((e) => visible[e])
    for (const e of EDGES) visible[e] = show
    if (show) setIdle(false)
  }

  function flashTop(ms: number) {
    visible.top = true
    setIdle(false)
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashTimer = null
      if (pins.size === 0) visible.top = false
    }, ms)
  }

  function attach(next: HTMLElement) {
    detach()
    el = next
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
  }

  function detach() {
    el?.removeEventListener('focusin', onFocusIn)
    el?.removeEventListener('focusout', onFocusOut)
    el = null
  }

  window.addEventListener('pointermove', onMove)
  if (initial) attach(initial)

  return {
    visible,
    pin,
    unpin,
    pinned: (reason) => pins.has(reason),
    toggleAll,
    flashTop,
    attach,
    stop() {
      window.removeEventListener('pointermove', onMove)
      detach()
      if (idleTimer) clearTimeout(idleTimer)
      if (flashTimer) clearTimeout(flashTimer)
      idleTimer = flashTimer = null
      pins.clear()
    },
  }
}
