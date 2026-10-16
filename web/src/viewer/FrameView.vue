<script setup lang="ts">
// One frame of a collection, laid out per spec §5.1.
// A stacked `pair` (narrow portrait) scrolls vertically inside the frame; the
// viewer drives that scroll through `canScrollInner` / `scrollInner`
// (the `InnerScroll` contract in input.ts), since the stage has touch-action: none.
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
/** Fractional scrollTop tolerance. */
const EDGE_PX = 1

const pairEl = ref<HTMLElement | null>(null)

const isStackedPair = computed(() => props.frame.layout === 'pair' && props.stacked)

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

function canScrollInner(dir: Dir): boolean {
  const el = pairEl.value
  if (!isStackedPair.value || !el) return false
  const max = el.scrollHeight - el.clientHeight
  return dir === 1 ? el.scrollTop < max - EDGE_PX : el.scrollTop > EDGE_PX
}

/** Scroll by `dy` px, clamped and instant. Returns the unconsumed residual. */
function scrollInner(dy: number): number {
  const el = pairEl.value
  if (!isStackedPair.value || !el) return dy
  const max = Math.max(0, el.scrollHeight - el.clientHeight)
  const before = el.scrollTop
  el.scrollTop = Math.min(max, Math.max(0, before + dy))
  const used = el.scrollTop - before
  return Math.abs(dy - used) < 0.5 ? 0 : dy - used
}

defineExpose({ canScrollInner, scrollInner })
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

    <div v-else-if="frame.layout === 'pair'" ref="pairEl" class="pair" :class="{ stacked: isStackedPair }">
      <div v-for="p in frame.photos" :key="p.id" class="pair-item" :style="{ flexGrow: aspect(p) }">
        <Photo :photo="p" layout="pair" :count="frame.photos.length" :live="live" :priority="priority" />
      </div>
    </div>

    <div v-else class="text-wrap">
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
}

.fit :deep(img),
.fit :deep(.placeholder) {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
}

.fit :deep(.placeholder) {
  height: 100%;
}

.pair {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--space-12);
}

.pair-item {
  flex-basis: 0;
  flex-shrink: 1;
  min-width: 0;
}

.pair-item :deep(img),
.pair-item :deep(.placeholder) {
  width: 100%;
  height: auto;
  max-height: 100%;
  object-fit: contain;
}

.pair.stacked {
  flex-direction: column;
  align-items: stretch;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.pair.stacked .pair-item {
  flex: none;
}

.text-wrap {
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
