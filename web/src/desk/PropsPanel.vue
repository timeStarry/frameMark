<script setup lang="ts">
// The desk's property panel (spec §4.4) for the selected frame: one
// PhotoProps per photo, the frame's FrameProps, and a way to the collection
// settings. Esc closes it; the parent owns focus return.
import { computed, useId } from 'vue'
import FrameProps from './FrameProps.vue'
import PhotoProps from './PhotoProps.vue'
import type { Desk } from './useDesk'

const props = defineProps<{ desk: Desk; index: number; locked: boolean }>()
const emit = defineEmits<{ close: []; openCollection: [] }>()

const uid = useId()
const photoIds = computed(() => {
  const f = props.desk.seq.value[props.index]
  return f ? [...new Set(f.photos.map((p) => p.id))] : []
})

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  emit('close')
}
</script>

<template>
  <aside class="props-panel" :aria-labelledby="`${uid}-h`" @keydown="onKeydown">
    <h2 :id="`${uid}-h`">属性</h2>
    <section v-if="photoIds.length > 0" :aria-labelledby="`${uid}-photos`">
      <h3 :id="`${uid}-photos`">照片</h3>
      <PhotoProps v-for="pid in photoIds" :key="pid" :desk="desk" :photo-id="pid" :locked="locked" />
    </section>
    <section :aria-labelledby="`${uid}-frame`">
      <h3 :id="`${uid}-frame`">帧</h3>
      <FrameProps :desk="desk" :index="index" :locked="locked" />
    </section>
    <section aria-label="合集">
      <button type="button" @click="emit('openCollection')">合集设置</button>
    </section>
  </aside>
</template>

<style scoped>
.props-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-24);
  padding: var(--space-16);
}
h2 {
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 1.25rem;
}
h3 {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: var(--space-12);
}
section {
  display: flex;
  flex-direction: column;
  gap: var(--space-16);
}
button {
  align-self: flex-start;
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
