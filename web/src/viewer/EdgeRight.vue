<script setup lang="ts">
// Right edge (spec §5.2): the vertical parameter line of the current frame's
// first photo. Not rendered when there is no public field.
import { computed } from 'vue'
import type { Frame } from '../api/types'
import { paramLine } from './format'

const props = defineProps<{ frame: Frame | null }>()
const emit = defineEmits<{ open: [] }>()

const parts = computed(() => {
  const f = props.frame
  if (!f || f.layout === 'text') return []
  return paramLine(f.photos[0]?.exif ?? null)
})
</script>

<template>
  <div v-if="parts.length" class="right">
    <button type="button" class="params vertical" aria-label="查看参数与直方图" @click="emit('open')">
      <template v-for="(p, i) in parts" :key="i">
        <span v-if="i > 0" class="dot" aria-hidden="true">·</span>
        <span class="part">{{ p }}</span>
      </template>
    </button>
  </div>
</template>

<style scoped>
.right {
  height: 100%;
  display: flex;
  align-items: center;
  padding-right: max(var(--space-8), env(safe-area-inset-right));
}

.params {
  writing-mode: vertical-rl;
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-12) var(--space-8);
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  letter-spacing: 0.04em;
  cursor: pointer;
}

.params:hover,
.params:focus-visible {
  background: rgba(255, 255, 255, 0.08);
}

.dot {
  color: var(--fg-muted);
}
</style>
