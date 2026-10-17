// layout.ts — pure placement for the salon wall (spec §4.1). No DOM.
export function hash(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function columnsFor(width: number): 1 | 2 | 3 {
  return width < 600 ? 1 : width < 1100 ? 2 : 3
}

export interface Placement { column: number; widthPct: number; align: 'start' | 'center' | 'end' }
export interface LayoutItem { id: string; aspect: number; count: number; featured: boolean }

const ALIGNS = ['start', 'center', 'end'] as const
const MAX_PANO = 2.4

export function salon(items: readonly LayoutItem[], columns: number): Placement[] {
  const cols = Math.max(1, Math.floor(columns))
  const heights = new Array<number>(cols).fill(0)
  const min = cols === 1 ? 0.85 : 0.7
  return items.map((it) => {
    const h = hash(it.id)
    const aspect = Number.isFinite(it.aspect) && it.aspect > 0 ? it.aspect : 1.5
    let w = 0.7 + ((h % 1000) / 1000) * 0.3
    if (aspect < 1) w -= 0.08
    if (aspect > 2) w += 0.1
    if (it.count >= 12) w += 0.05
    if (it.featured) w = 1
    w = Math.min(1, Math.max(min, w))
    let column = 0
    for (let c = 1; c < cols; c++) if (heights[c]! < heights[column]!) column = c
    heights[column]! += w / Math.min(aspect, MAX_PANO) + 0.15 // + caption/gap allowance in column widths
    const widthPct = Math.round(w * 1000) / 10
    return { column, widthPct, align: widthPct >= 100 ? 'center' : ALIGNS[(h >>> 10) % 3]! }
  })
}

export function sweepIndex(x: number, width: number, n: number): number {
  if (n <= 0) return -1
  if (width <= 0) return 0
  return Math.min(n - 1, Math.max(0, Math.floor((x / width) * n)))
}
