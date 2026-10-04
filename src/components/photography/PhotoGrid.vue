<script setup>
import { computed } from 'vue'
import PhotoTile from './PhotoTile.vue'
const props = defineProps({ works: { type: Array, default: () => [] }, showAuthor: { type: Boolean, default: true }, eagerFirst: { type: Boolean, default: true }, column: Boolean, paginated: Boolean, excludeId: { type: String, default: '' }, revealKey: { type: String, default: '' } })
defineEmits(['navigate'])
const batches = computed(() => {
  if (!props.paginated) return [props.works.filter(work => work.id !== props.excludeId)]
  const result = []
  for (let i = 0; i < props.works.length; i += 12) result.push(props.works.slice(i, i + 12).filter(work => work.id !== props.excludeId))
  return result
})
</script>

<template>
  <div class="photo-grid-pages">
    <div v-for="(batch, page) in batches" :key="page" class="photo-grid" :class="{ 'photo-grid--column': column }">
      <PhotoTile v-for="(work, index) in batch" :key="work.id" :work="work" :index="index" :append="paginated && page > 0" :eager="eagerFirst && page === 0 && index === 0" :show-author="showAuthor" :reveal-key="revealKey" @navigate="$emit('navigate', $event)" />
    </div>
  </div>
</template>

<style scoped>
.photo-grid-pages { display: grid; gap: 36px; }
.photo-grid { display: flex; flex-wrap: wrap; align-items: flex-start; column-gap: 24px; row-gap: 36px; }
.photo-grid::after { content: ''; flex: 999 1 0; }
.photo-grid--column { display: block; max-width: 1000px; margin-inline: auto; }
.photo-grid--column :deep(.photo-tile) { margin-bottom: 40px; }
.photo-grid--column::after { display: none; }
@media (max-width: 899px) { .photo-grid { column-gap: 16px; row-gap: 28px; } }
@media (max-width: 639px) { .photo-grid { display: block; } .photo-grid :deep(.photo-tile) { margin-bottom: 32px; } .photo-grid::after { display: none; } }
</style>
