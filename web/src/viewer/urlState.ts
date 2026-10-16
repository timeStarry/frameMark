type QueryValue = string | null | (string | null)[] | undefined

/** The part of a vue-router route this module reads. */
export interface RouteLike {
  query: Record<string, QueryValue>
}

export interface ViewState {
  /** 1-based frame number; 1 when `f` is missing or invalid. */
  frame: number
  /** Entry wall (`square`, `user`, `album:{id}`) or null. */
  wall: string | null
}

function first(v: QueryValue): string | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

/** Reads `f` and `wall`. Pass `maxFrame` to reject frames past the end. */
export function readState(route: RouteLike, maxFrame?: number): ViewState {
  const f = first(route.query.f)
  let frame = 1
  if (f !== null && /^\d+$/.test(f)) {
    const n = Number(f)
    if (Number.isSafeInteger(n) && n >= 1 && (maxFrame === undefined || n <= maxFrame)) frame = n
  }
  const wall = first(route.query.wall)
  return { frame, wall: wall ? wall : null }
}

/** Query object for router.replace when the frame changes. */
export function frameQuery(n: number): { f: string } {
  return { f: String(n) }
}

/** Shareable link: `/c/:id` plus optional `f`, never `wall`. */
export function shareURL(origin: string, id: string, frame?: number): string {
  const base = `${origin.replace(/\/+$/, '')}/c/${encodeURIComponent(id)}`
  return frame !== undefined && Number.isSafeInteger(frame) && frame > 1 ? `${base}?f=${frame}` : base
}
