<script setup lang="ts">
// End frame (spec §5.4): name · count, then 从头再看 / 作者主页 / 下一组
// (or 回到墙 without a next). Preview mode offers only 从头再看.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import type { Collection, Neighbors } from '../api/types'
import { srcset } from './media'

const props = defineProps<{
  collection: Collection
  neighbors: Neighbors | null
  mode: 'public' | 'preview'
}>()

const emit = defineEmits<{
  go: [n: number]
  navigate: [dir: 1]
  exit: []
}>()

const count = computed(() => props.collection.frames.reduce((n, f) => n + f.photos.length, 0))
const next = computed(() => props.neighbors?.next ?? null)
</script>

<template>
  <div class="end">
    <p class="name">
      <span class="title">{{ collection.title }}</span>
      <span class="count"> · {{ count }} 张</span>
    </p>
    <div class="actions">
      <button type="button" class="action" @click="emit('go', 1)">从头再看</button>
      <template v-if="mode === 'public'">
        <RouterLink class="action" :to="`/u/${encodeURIComponent(collection.owner.id)}`">作者主页</RouterLink>
        <button v-if="next" type="button" class="action next" @click="emit('navigate', 1)">
          <picture v-if="next.cover">
            <source type="image/avif" :srcset="srcset(next.cover, 'avif')" sizes="120px" />
            <source type="image/webp" :srcset="srcset(next.cover, 'webp')" sizes="120px" />
            <img :src="next.cover.tiers.w480.jpeg" alt="" loading="lazy" decoding="async" />
          </picture>
          <span class="next-text">
            <span class="label">下一组</span>
            <span class="next-title">{{ next.title }}</span>
            <span class="next-owner">{{ next.owner.name }}</span>
          </span>
        </button>
        <button v-else type="button" class="action" @click="emit('exit')">回到墙</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.end {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-32);
  max-width: 100%;
  text-align: center;
}

.name {
  margin: 0;
}

.title {
  font-family: var(--font-title);
  font-size: 22px;
}

.count {
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: var(--space-12);
}

.action {
  display: inline-flex;
  align-items: center;
  gap: var(--space-12);
  min-height: 44px;
  padding: var(--space-8) var(--space-16);
  border: 1px solid var(--line);
  border-radius: 4px;
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 14px;
  text-decoration: none;
  cursor: pointer;
}

.action:hover,
.action:focus-visible {
  border-color: var(--fg-muted);
}

.next img {
  display: block;
  width: 72px;
  height: 48px;
  object-fit: cover;
  border-radius: 2px;
}

.next-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.label,
.next-owner {
  color: var(--fg-muted);
  font-size: 12px;
}
</style>
