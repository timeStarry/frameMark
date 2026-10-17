<script setup lang="ts">
// Histogram (spec §5.3): luma, or R/G/B as three translucent overlaid areas.
import { computed, ref } from 'vue'
import type { Histogram } from '../api/types'
import { toPath } from './histogram'

const props = defineProps<{ histogram: Histogram | null }>()

const W = 256
const H = 80
const mode = ref<'luma' | 'rgb'>('luma')

const paths = computed(() => {
  const h = props.histogram
  if (!h) return []
  if (mode.value === 'luma') return [{ d: toPath(h[0], W, H), cls: 'luma' }]
  return (['r', 'g', 'b'] as const).map((cls, i) => ({ d: toPath(h[i + 1]!, W, H), cls }))
})
</script>

<template>
  <figure v-if="histogram" class="hist">
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" aria-label="直方图">
      <path v-for="p in paths" :key="p.cls" :d="p.d" :class="p.cls" />
    </svg>
    <div class="modes" role="group" aria-label="直方图视图">
      <button type="button" :aria-pressed="mode === 'luma' ? 'true' : 'false'" @click="mode = 'luma'">亮度</button>
      <button type="button" :aria-pressed="mode === 'rgb' ? 'true' : 'false'" @click="mode = 'rgb'">RGB</button>
    </div>
  </figure>
</template>

<style scoped>
.hist {
  margin: 0;
}

svg {
  display: block;
  width: 100%;
  height: 80px;
  border-bottom: 1px solid var(--line);
}

.luma {
  fill: rgba(232, 230, 225, 0.55);
}

.r,
.g,
.b {
  mix-blend-mode: screen;
}

.r {
  fill: rgba(230, 80, 70, 0.55);
}

.g {
  fill: rgba(90, 200, 110, 0.55);
}

.b {
  fill: rgba(80, 130, 240, 0.55);
}

.modes {
  display: flex;
  gap: var(--space-4);
  margin-top: var(--space-8);
}

.modes button {
  padding: var(--space-4) var(--space-8);
  border: 1px solid var(--line);
  border-radius: 4px;
  background: transparent;
  color: var(--fg-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.modes button[aria-pressed='true'] {
  color: var(--fg);
  border-color: var(--fg-muted);
}
</style>
