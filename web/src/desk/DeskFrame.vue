<script setup lang="ts">
// One frame's card in the sequence (spec §4.3): number, layout label and
// thumbnails (2–3 for a pair), or a text frame's first two lines. Purely
// presentational; the list item around it owns focus, keys and drag.
import { computed } from 'vue'
import Cover from '../walls/Cover.vue'
import { LAYOUT_LABEL, textPreview } from './labels'
import type { DeskFrame } from './sequence'

const props = defineProps<{ frame: DeskFrame; index: number }>()
const THUMB_TIERS = ['w480'] as const
const text = computed(() => textPreview(props.frame))
</script>

<template>
  <div class="desk-frame" :class="`layout-${frame.layout}`" aria-hidden="true">
    <span class="num">{{ index + 1 }}</span>
    <div v-if="frame.layout === 'text'" class="text">
      <p v-if="text.trim() !== ''">{{ text }}</p>
      <p v-else class="placeholder">空文字页</p>
    </div>
    <div v-else class="thumbs">
      <span v-for="p in frame.photos" :key="p.id" class="thumb">
        <Cover :media="p.media" sizes="96px" :eager="false" :high="false" alt="" :aspect="1.5" :tiers="THUMB_TIERS" />
      </span>
    </div>
    <span class="layout">{{ LAYOUT_LABEL[frame.layout] }}</span>
  </div>
</template>

<style scoped>
.desk-frame {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  min-height: 64px;
  padding: var(--space-8) var(--space-12);
}
.num {
  flex: 0 0 2.5em;
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.thumbs {
  display: flex;
  flex: 1 1 auto;
  gap: var(--space-4);
  min-width: 0;
}
.thumb {
  flex: 0 0 96px;
  width: 96px;
}
/* The card is the drag source: thumbnails must not start an image drag. */
.thumb :deep(img) {
  -webkit-user-drag: none;
  user-select: none;
  pointer-events: none;
}
.text {
  flex: 1 1 auto;
  min-width: 0;
}
.text p {
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-line;
  font-family: var(--font-title);
}
.text .placeholder {
  color: var(--fg-muted);
}
.layout {
  flex: 0 0 auto;
  padding: 0 var(--space-4);
  border: 1px solid var(--line);
  color: var(--fg-muted);
  font-size: 0.85em;
  line-height: 20px;
}
</style>
