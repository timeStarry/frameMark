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

function isFocusVisible(t: EventTarget | null): boolean {
  try {
    return t instanceof Element && t.matches(':focus-visible')
  } catch {
    return true // no :focus-visible support: treat every focus as keyboard focus
  }
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

  const focusPin = (edge: Edge) => `focus:${edge}`
  /** Pins that hold every edge (menu, info layer); a focus pin holds only its own edge. */
  const holdsAll = () => [...pins].some((p) => !p.startsWith('focus:'))
  /** The edge may fade now: nothing holds it. */
  const mayHide = (edge: Edge) => !holdsAll() && !pins.has(focusPin(edge)) && !(edge === 'top' && flashTimer)

  function hideAll() {
    if (holdsAll()) return
    for (const e of EDGES) if (mayHide(e)) visible[e] = false
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
      else if (mayHide(edge)) visible[edge] = false
    }
    setIdle(false)
    armIdle()
  }

  const onFocusIn = (e: FocusEvent) => {
    const edge = edgeOf(e.target)
    if (!edge) return
    // Only keyboard focus pins: Chromium focuses a button on mouse click too,
    // and that must not hold the edge or block the idle fade (spec §5.2).
    if (!isFocusVisible(e.target)) return
    visible[edge] = true
    setIdle(false)
    pin(focusPin(edge))
  }

  const onFocusOut = (e: FocusEvent) => {
    const edge = edgeOf(e.target)
    if (!edge) return
    // Focus moving within the same edge keeps it pinned.
    if (edgeOf(e.relatedTarget) === edge) return
    unpin(focusPin(edge))
  }

  function pin(reason: string) {
    pins.add(reason)
    setIdle(false)
  }

  function unpin(reason: string) {
    if (!pins.delete(reason)) return
    if (!holdsAll()) armIdle()
  }

  function toggleAll() {
    const show = !EDGES.some((e) => visible[e])
    for (const e of EDGES) visible[e] = show
    if (show) {
      setIdle(false)
      armIdle() // a tap reveal fades after the same 2s (spec §5.2)
    }
  }

  function flashTop(ms: number) {
    visible.top = true
    setIdle(false)
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashTimer = null
      if (mayHide('top')) visible.top = false
    }, ms)
  }

  let listening = false
  function listen() {
    if (listening) return
    listening = true
    window.addEventListener('pointermove', onMove)
  }

  function attach(next: HTMLElement) {
    detach()
    listen() // re-arms after stop()
    el = next
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
  }

  function detach() {
    el?.removeEventListener('focusin', onFocusIn)
    el?.removeEventListener('focusout', onFocusOut)
    el = null
  }

  listen()
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
      listening = false
      detach()
      if (idleTimer) clearTimeout(idleTimer)
      if (flashTimer) clearTimeout(flashTimer)
      idleTimer = flashTimer = null
      pins.clear()
    },
  }
}
