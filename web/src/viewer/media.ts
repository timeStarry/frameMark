import { TIERS, type FrameLayout, type ImageFormat, type Media, type Tier } from '../api/types'

const TIER_EDGE: Record<Tier, number> = { w480: 480, w1280: 1280, w2400: 2400, w3840: 3840 }

/** Real pixel width of a tier: the long edge is capped at the tier size, never upscaled. */
export function tierWidth(media: Media, tier: Tier): number {
  const long = Math.max(media.width, media.height)
  const scale = long > 0 ? Math.min(1, TIER_EDGE[tier] / long) : 1
  return Math.round(media.width * scale)
}

/** Tiers with distinct real widths, smallest first. Duplicates keep the smallest tier. */
function distinctTiers(media: Media): { tier: Tier; width: number }[] {
  const out: { tier: Tier; width: number }[] = []
  for (const tier of TIERS) {
    const width = tierWidth(media, tier)
    if (out.length > 0 && out[out.length - 1]!.width >= width) continue
    out.push({ tier, width })
  }
  return out
}

/** `url 480w, url 1280w, …` with real widths. */
export function srcset(media: Media, format: ImageFormat): string {
  return distinctTiers(media)
    .map(({ tier, width }) => `${media.tiers[tier][format]} ${width}w`)
    .join(', ')
}

/** `sizes` for a frame. Pair frames stack vertically on narrow portrait screens. */
export function sizesFor(layout: FrameLayout, count: number): string {
  if (layout === 'pair' && count > 1) {
    return `(max-width: 599px) and (orientation: portrait) 100vw, ${Math.ceil(100 / count)}vw`
  }
  return '100vw'
}

/** AVIF URL of the first tier covering viewport × dpr device pixels, else the largest. */
export function preloadURL(media: Media, viewportCSSWidth: number, dpr: number): string {
  const need = viewportCSSWidth * dpr
  const tiers = distinctTiers(media)
  const pick = tiers.find((t) => t.width >= need) ?? tiers[tiers.length - 1]
  return media.tiers[pick?.tier ?? 'w3840'].avif
}
