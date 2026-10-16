import type { Exif } from '../api/types'

export interface ExifRow {
  label: string
  value: string
}

/** Round to `digits` decimals and drop trailing zeros ("2.0" -> "2"). */
function num(n: number, digits: number): string {
  const v = Number(n.toFixed(digits))
  return String(v === 0 ? 0 : v)
}

export function formatFocal(exif: Exif): string | null {
  if (exif.focalLength === undefined) {
    // Only the 35mm equivalent is known: show it alone, labelled.
    return exif.focalLength35mm === undefined ? null : `等效 ${num(exif.focalLength35mm, 0)}mm`
  }
  const real = num(exif.focalLength, 1)
  if (exif.focalLength35mm === undefined) return `${real}mm`
  const eq = num(exif.focalLength35mm, 0)
  return eq === real ? `${real}mm` : `${real}mm (${eq}mm)`
}

export function formatAperture(exif: Exif): string | null {
  return exif.aperture === undefined ? null : `f/${num(exif.aperture, 1)}`
}

function shutterFromSeconds(s: number): string | null {
  if (!Number.isFinite(s) || s <= 0) return null
  if (s >= 1) return `${num(s, 1)}"`
  const inv = 1 / s
  const n = Math.round(inv)
  // Short exposures are always 1/N. Between 0.3s and 1s keep a decimal
  // unless the value really is 1/N (0.3" vs 1/3).
  if (s < 0.3 || Math.abs(inv - n) / inv < 0.01) return `1/${n}`
  return `${num(s, 1)}"`
}

export function formatShutter(exif: Exif): string | null {
  const raw = exif.shutter?.trim()
  if (raw) {
    const frac = /^(\d+)\/(\d+)$/.exec(raw)
    if (frac) {
      const a = Number(frac[1])
      const b = Number(frac[2])
      if (a === 1) return raw
      if (b > 0) return shutterFromSeconds(a / b) ?? raw
      return raw
    }
    if (/^\d+(\.\d+)?$/.test(raw)) return shutterFromSeconds(Number(raw)) ?? raw
    return raw
  }
  return exif.exposureSeconds === undefined ? null : shutterFromSeconds(exif.exposureSeconds)
}

function biasText(b: number): string {
  const t = num(b, 1)
  return t === '0' ? '0 EV' : `${b > 0 ? '+' : ''}${t} EV`
}

/** Returns null for a bias that rounds to zero. */
export function formatBias(exif: Exif): string | null {
  if (exif.exposureBias === undefined) return null
  const t = biasText(exif.exposureBias)
  return t === '0 EV' ? null : t
}

/**
 * Unix ms -> "YYYY.MM.DD" in UTC.
 *
 * Known limitation: the backend stores takenAt as the wall clock interpreted
 * as UTC when EXIF has no OffsetTimeOriginal (UTC formatting is then exact),
 * but as the true UTC instant when an offset is present. For the latter the
 * shown day can be off by one for shots near local midnight. No frontend
 * timezone choice fixes both cases; SP4 will store the offset and fix this.
 */
export function formatDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`
}

/** Right-edge parameter line: focal, aperture, shutter, ISO, bias. */
export function paramLine(exif: Exif | null): string[] {
  if (!exif) return []
  const parts = [
    formatFocal(exif),
    formatAperture(exif),
    formatShutter(exif),
    exif.iso === undefined ? null : `ISO ${exif.iso}`,
    formatBias(exif),
  ]
  return parts.filter((p): p is string => p !== null)
}

/** Info layer table with Chinese labels. Location is never part of Exif. */
export function exifTable(exif: Exif | null): ExifRow[] {
  if (!exif) return []
  const rows: [string, string | null][] = [
    ['机身', exif.camera ?? null],
    ['镜头', exif.lens ?? null],
    ['焦距', formatFocal(exif)],
    ['光圈', formatAperture(exif)],
    ['快门', formatShutter(exif)],
    ['感光度', exif.iso === undefined ? null : `ISO ${exif.iso}`],
    ['曝光补偿', exif.exposureBias === undefined ? null : biasText(exif.exposureBias)],
    ['拍摄日期', exif.takenAt === undefined ? null : formatDate(exif.takenAt)],
  ]
  return rows.filter((r): r is [string, string] => r[1] !== null && r[1] !== '').map(([label, value]) => ({ label, value }))
}
