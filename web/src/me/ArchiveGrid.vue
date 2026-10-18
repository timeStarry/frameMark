<script setup lang="ts">
// The archive's even square grid (spec §5). No text under tiles: the title
// and date are the button's label; status overlays describe it.
import { useId } from 'vue'
import type { OwnerPhoto } from '../api/types'
import Cover from '../walls/Cover.vue'
import { formatDate } from '../viewer/format'

defineProps<{ items: OwnerPhoto[]; selectedId: string | null; panelId: string }>()
const emit = defineEmits<{ select: [id: string] }>()

const uid = useId()
const TILE_TIERS = ['w480', 'w1280'] as const

function label(p: OwnerPhoto): string {
  const t = p.exif?.takenAt
  const date = t === undefined ? '未知日期' : formatDate(t, p.exif?.takenOffsetMinutes)
  return `${p.title}，${date}`
}

function overlay(p: OwnerPhoto): 'processing' | 'failed' | null {
  if (p.status === 'failed') return 'failed'
  if (p.status === 'processing' || p.status === 'uploading') return 'processing'
  return null
}
</script>

<template>
  <ul class="grid">
    <li v-for="(p, i) in items" :key="p.id">
      <button
        type="button"
        class="tile"
        :data-photo-id="p.id"
        :aria-label="label(p)"
        :aria-describedby="overlay(p) ? `${uid}-s-${p.id}` : undefined"
        :aria-expanded="selectedId === p.id ? 'true' : 'false'"
        :aria-controls="selectedId === p.id ? panelId : undefined"
        @click="emit('select', p.id)"
      >
        <Cover
          :media="p.media"
          sizes="(max-width: 599px) 33vw, 240px"
          :eager="i < 12"
          :high="false"
          alt=""
          :aspect="1"
          :tiers="TILE_TIERS"
        />
        <span v-if="overlay(p)" :id="`${uid}-s-${p.id}`" class="status" :data-status="overlay(p)">
          <template v-if="overlay(p) === 'processing'">处理中</template>
          <template v-else>
            <span class="status-title">处理失败</span>
            <span v-if="p.error" class="status-error">{{ p.error }}</span>
          </template>
        </span>
      </button>
    </li>
  </ul>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--space-8);
  margin: 0;
  padding: 0;
  list-style: none;
}
@media (max-width: 599px) {
  .grid {
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-4);
  }
}
.tile {
  position: relative;
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
}
.tile[aria-expanded='true'] {
  outline: 2px solid var(--fg-muted);
  outline-offset: 2px;
}
.tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.status {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-4) var(--space-8);
  /* Near-opaque so --fg text stays above 4.5:1 over any photo. */
  background: rgba(11, 11, 12, 0.86);
  color: var(--fg);
  font-size: 0.8125rem;
  line-height: 1.35;
  text-align: left;
}
.status[data-status='processing'] {
  inset: 0;
  justify-content: center;
  align-items: center;
  background: rgba(11, 11, 12, 0.72);
  animation: pulse 1.6s ease-in-out infinite;
}
.status-error {
  color: var(--fg);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
@keyframes pulse {
  50% {
    background: rgba(11, 11, 12, 0.6);
  }
}
@media (prefers-reduced-motion: reduce) {
  .status[data-status='processing'] {
    animation: none;
  }
}
</style>
