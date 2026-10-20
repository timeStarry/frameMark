<script setup lang="ts">
// The upload tray (spec §6): one row per file with its name, state label,
// message and a progress bar. Changes are announced only as a polite summary
// of counts, never row by row.
import { computed, useId } from 'vue'
import { isFinished, summarize, type QueueItem } from './uploadQueue'

const props = defineProps<{ items: Readonly<QueueItem[]> }>()
defineEmits<{ retry: [key: string]; clear: [] }>()

const uid = useId()
const LABELS: Record<QueueItem['state'], string> = {
  queued: '排队',
  hashing: '计算中',
  uploading: '上传中',
  processing: '处理中',
  done: '完成',
  duplicate: '重复',
  failed: '失败',
  rejected: '不支持',
}

const summary = computed(() => summarize(props.items))
const canClear = computed(() => props.items.some((i) => isFinished(i) && i.state !== 'failed' && i.state !== 'rejected'))

/** Stages with a known fraction show it; the rest are indeterminate while busy. */
function progressValue(i: QueueItem): number | undefined {
  if (i.state === 'uploading') return i.progress
  if (i.state === 'done' || i.state === 'duplicate' || i.state === 'processing') return 1
  if (i.state === 'queued' || i.state === 'failed' || i.state === 'rejected') return 0
  return undefined
}
</script>

<template>
  <!-- The live region stays in the DOM even when empty so its first update is announced. -->
  <section class="tray" :class="{ empty: items.length === 0 }" :aria-labelledby="`${uid}-h`">
    <div class="head">
      <h2 v-show="items.length" :id="`${uid}-h`">上传</h2>
      <p class="summary" aria-live="polite">{{ summary }}</p>
      <button v-if="canClear" type="button" class="clear" @click="$emit('clear')">清除已完成</button>
    </div>
    <ul v-if="items.length">
      <li v-for="i in items" :key="i.key" :data-state="i.state">
        <span :id="`${uid}-${i.key}-n`" class="name">{{ i.file.name }}</span>
        <span :id="`${uid}-${i.key}-s`" class="state">{{ LABELS[i.state] }}</span>
        <progress
          :aria-labelledby="`${uid}-${i.key}-n ${uid}-${i.key}-s`"
          max="1"
          :value="progressValue(i)"
        />
        <span v-if="i.message" class="message">{{ i.message }}</span>
        <button
          v-if="i.state === 'failed' && i.retryable"
          type="button"
          class="retry"
          :aria-describedby="`${uid}-${i.key}-n`"
          @click="$emit('retry', i.key)"
        >
          重试
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.tray {
  margin: var(--space-16) 0;
  border: 1px solid var(--line);
  padding: var(--space-12) var(--space-16);
}
.tray.empty {
  margin: 0;
  border: 0;
  padding: 0;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-12);
}
h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 400;
}
.summary {
  flex: 1;
  margin: 0;
  color: var(--fg-muted);
}
ul {
  list-style: none;
  margin: var(--space-12) 0 0;
  padding: 0;
  display: grid;
  gap: var(--space-8, 8px);
}
li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 4px var(--space-12);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.state {
  color: var(--fg-muted);
}
li[data-state='failed'] .state,
li[data-state='rejected'] .state {
  color: var(--fg);
}
progress {
  grid-column: 1 / 3;
  width: 100%;
  height: 4px;
  accent-color: var(--accent);
}
.message {
  grid-column: 1 / 3;
  color: var(--fg-muted);
  font-size: 0.875rem;
}
.retry {
  grid-column: 3;
  grid-row: 1 / span 3;
}
button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
@media (prefers-reduced-motion: no-preference) {
  progress {
    transition: opacity var(--dur-fade);
  }
}
</style>
