// URL query <-> ArchiveQuery (spec §5). Pure. Names match internal/api/archive.go;
// values the backend would reject with 400 are dropped instead of sent.
import type { LocationQuery } from 'vue-router'
import type { ArchiveQuery, PhotoStatus } from '../api/types'

/** Status values the archive filter offers (backend accepts all four PhotoStatus values). */
export const STATUS_FILTERS: readonly PhotoStatus[] = ['processing', 'failed']

const ALL_STATUSES: readonly PhotoStatus[] = ['uploading', 'processing', 'ready', 'failed']
const MAX_RUNES = 200

/** One string value, or null for missing / repeated / null entries. */
function one(q: LocationQuery, key: string): string | null {
  const v = q[key]
  return typeof v === 'string' ? v : null
}

function text(v: string | null): string | undefined {
  if (v === null || v === '' || [...v].length > MAX_RUNES) return undefined
  return v
}

function focal(v: string | null): number | undefined {
  if (v === null || !/^\d+(\.\d+)?$/.test(v)) return undefined
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function fromRoute(query: LocationQuery): ArchiveQuery {
  const out: ArchiveQuery = {}
  const y = one(query, 'year')
  if (y !== null && /^[1-9]\d{3}$/.test(y)) {
    const n = Number(y)
    if (n >= 1900 && n <= 2100) out.year = n
  }
  const camera = text(one(query, 'camera'))
  if (camera !== undefined) out.camera = camera
  const lens = text(one(query, 'lens'))
  if (lens !== undefined) out.lens = lens
  const fmin = focal(one(query, 'focal_min'))
  const fmax = focal(one(query, 'focal_max'))
  if (!(fmin !== undefined && fmax !== undefined && fmin > fmax)) {
    if (fmin !== undefined) out.focalMin = fmin
    if (fmax !== undefined) out.focalMax = fmax
  }
  const inc = one(query, 'in_collection')
  if (inc === 'true') out.inCollection = true
  else if (inc === 'false') out.inCollection = false
  const st = one(query, 'status')
  if (st !== null && (ALL_STATUSES as readonly string[]).includes(st)) out.status = st as PhotoStatus
  return out
}

export function toQuery(q: ArchiveQuery): Record<string, string> {
  const out: Record<string, string> = {}
  if (q.year !== undefined) out.year = String(q.year)
  if (q.camera) out.camera = q.camera
  if (q.lens) out.lens = q.lens
  if (q.focalMin !== undefined) out.focal_min = String(q.focalMin)
  if (q.focalMax !== undefined) out.focal_max = String(q.focalMax)
  if (q.inCollection !== undefined) out.in_collection = q.inCollection ? 'true' : 'false'
  if (q.status !== undefined) out.status = q.status
  return out
}

export function isFiltered(q: ArchiveQuery): boolean {
  return Object.keys(toQuery(q)).length > 0
}
