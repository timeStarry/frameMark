function n2(v: number): string {
  const r = Number(v.toFixed(2))
  return String(r === 0 ? 0 : r)
}

/**
 * Closed SVG area path for one histogram channel, scaled so the peak bin
 * touches the top. Bins are spread evenly from x=0 to x=w; a polyline is
 * smooth enough at 64 bins.
 */
export function toPath(bins: number[], w: number, h: number): string {
  if (bins.length === 0) return ''
  const peak = Math.max(...bins)
  const y = (v: number) => (peak > 0 ? h - (v / peak) * h : h)
  const pts =
    bins.length === 1
      ? [[0, y(bins[0]!)], [w, y(bins[0]!)]]
      : bins.map((v, i) => [(i * w) / (bins.length - 1), y(v)])
  const line = pts.map(([px, py]) => `L${n2(px!)} ${n2(py!)}`).join('')
  return `M0 ${n2(h)}${line}L${n2(w)} ${n2(h)}Z`
}
