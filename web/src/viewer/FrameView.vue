<script setup lang="ts">
// One frame of a collection, laid out per spec §5.1.
// A stacked `pair` (narrow portrait) and a long `text` frame scroll vertically
// inside the frame; the viewer drives that scroll through `canScrollInner` /
// `scrollInner` (the `InnerScroll` contract in input.ts), since the stage has
// touch-action: none.
import { computed, ref } from 'vue'
import type { Frame, PhotoView } from '../api/types'
import type { Dir } from './gesture'
import Photo from './Photo.vue'

const props = defineProps<{
  frame: Frame
  /** Inside the render window: real <img> nodes. Otherwise ratio placeholders only. */
  live: boolean
  /** First frame shown. */
  priority: boolean
  /** Narrow portrait viewport: pair frames stack vertically. */
  stacked: boolean
}>()

/** Matte share of the viewport when the frame gives none. */
const DEFAULT_MATTE = 0.8
/** A position within this distance of an edge counts as at the boundary (fractional scrollTop). */
const EDGE_PX = 0.5
const PAIR_GAP_PX = 12

const pairEl = ref<HTMLElement | null>(null)
const textEl = ref<HTMLElement | null>(null)

const isStackedPair = computed(() => props.frame.layout === 'pair' && props.stacked)
/** True when this frame owns an inner scroller (it may still be too short to scroll). */
const hasInner = computed(() => isStackedPair.value || props.frame.layout === 'text')
const scroller = (): HTMLElement | null =>
  !hasInner.value ? null : props.frame.layout === 'text' ? textEl.value : pairEl.value

const matteStyle = computed(() => {
  const r = props.frame.matteRatio
  const pct = `${Math.round((r !== null && r > 0 && r <= 1 ? r : DEFAULT_MATTE) * 1000) / 10}%`
  return { width: pct, height: pct }
})

function aspect(p: PhotoView): number {
  const w = p.media?.width || p.width || 3
  const h = p.media?.height || p.height || 2
  return w / h
}

const round4 = (n: number) => Number(n.toFixed(4))

/**
 * Pair sizing inputs (I1): each item is min(share of the row width, row height × aspect),
 * so the row fits whichever axis limits it and the photos stay equal height.
 */
const pairStyle = computed(() => {
  const ps = props.frame.photos
  return {
    '--s': round4(ps.reduce((sum, p) => sum + aspect(p), 0) || 1),
    '--g': `${PAIR_GAP_PX * Math.max(0, ps.length - 1)}px`,
  }
})

const maxScroll = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight)

function canScrollInner(dir: Dir): boolean {
  const el = scroller()
  if (!el) return false
  return dir === 1 ? el.scrollTop < maxScroll(el) - EDGE_PX : el.scrollTop > EDGE_PX
}

/**
 * Scroll by `dy` px, clamped and instant. Returns the unconsumed residual
 * `dy - used`, computed from geometry rather than the re-read scrollTop
 * (engines may round it): 0 mid-range, exactly `dy` at the boundary.
 */
function scrollInner(dy: number): number {
  const el = scroller()
  if (!el) return dy
  const before = el.scrollTop
  const target = before + dy
  const clamped = Math.min(maxScroll(el), Math.max(0, target))
  el.scrollTop = clamped
  if (clamped === target) return 0
  if (clamped === before) return dy
  return dy - (clamped - before)
}

/** Put the inner scroller at its start (entering forward) or end (entering backward). */
function resetInner(edge: 'start' | 'end') {
  const el = scroller()
  if (el) el.scrollTop = edge === 'start' ? 0 : maxScroll(el)
}

defineExpose({ hasInner: () => hasInner.value, canScrollInner, scrollInner, resetInner })
</script>

<template>
  <div class="frame" :class="`layout-${frame.layout}`">
    <div v-if="frame.layout === 'full'" class="fit">
      <Photo v-for="p in frame.photos.slice(0, 1)" :key="p.id" :photo="p" layout="full" :count="1" :live="live" :priority="priority" />
    </div>

    <div v-else-if="frame.layout === 'matted'" class="fit">
      <div class="matte" :style="matteStyle">
        <Photo v-for="p in frame.photos.slice(0, 1)" :key="p.id" :photo="p" layout="matted" :count="1" :live="live" :priority="priority" />
      </div>
    </div>

    <div v-else-if="frame.layout === 'pair'" ref="pairEl" class="pair" :class="{ stacked: isStackedPair }" :style="pairStyle">
      <div v-for="p in frame.photos" :key="p.id" class="pair-item" :style="{ '--a': round4(aspect(p)) }">
        <Photo :photo="p" layout="pair" :count="frame.photos.length" :live="live" :priority="priority" />
      </div>
    </div>

    <div v-else ref="textEl" class="text-wrap">
      <p class="text">{{ frame.text ?? '' }}</p>
    </div>
  </div>
</template>

<style scoped>
.frame {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.fit,
.matte {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  container-type: size;
}

.fit :deep(img) {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
}

/* Same box as a contained image of aspect --a (M1). */
.fit :deep(.placeholder) {
  width: min(100cqw, calc(100cqh * var(--a)));
  height: auto;
}

.pair {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: var(--space-12);
  container-type: size;
}

.pair-item {
  flex: none;
  min-width: 0;
  width: min(calc((100cqw - var(--g)) * var(--a) / var(--s)), calc(100cqh * var(--a)));
}

.pair-item :deep(img),
.pair-item :deep(.placeholder) {
  width: 100%;
  height: auto;
}

.pair.stacked {
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.pair.stacked .pair-item {
  width: 100%;
}

.text-wrap {
  max-height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-24);
}

.text {
  max-width: 32em;
  font-family: var(--font-title);
  line-height: 1.9;
  color: var(--fg);
  white-space: pre-line;
  text-align: center;
}
</style>
