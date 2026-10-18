<script setup lang="ts">
// The archive detail panel (spec §5): a right-hand <aside> from 768px, a
// bottom sheet below. Not modal: no focus trap. Esc is handled by the route.
import { computed, useId } from 'vue'
import type { OwnerPhoto } from '../api/types'
import Cover from '../walls/Cover.vue'
import { exifTable } from '../viewer/format'

const props = defineProps<{ photo: OwnerPhoto; panelId: string }>()
const emit = defineEmits<{ close: []; delete: [] }>()

const uid = useId()

/** internal/domain PublicFieldKeys -> the labels exifTable uses. */
const FIELD_LABELS: Record<string, string> = {
  camera: '机身',
  lens: '镜头',
  focal_length: '焦距',
  aperture: '光圈',
  shutter: '快门',
  iso: '感光度',
  exposure_bias: '曝光补偿',
  taken_date: '拍摄日期',
}

const rows = computed(() => exifTable(props.photo.exif))
const fields = computed(() => props.photo.publicFields.map((k) => ({ key: k, label: FIELD_LABELS[k] ?? k })))
const aspect = computed(() => {
  const m = props.photo.media
  return m && m.width > 0 && m.height > 0 ? m.width / m.height : 1.5
})
</script>

<template>
  <aside :id="panelId" class="panel" :aria-labelledby="`${uid}-title`">
    <div class="head">
      <h2 :id="`${uid}-title`">{{ photo.title }}</h2>
      <button type="button" class="close" @click="emit('close')">关闭</button>
    </div>
    <div class="image">
      <Cover
        :media="photo.media"
        sizes="(min-width: 768px) 400px, 100vw"
        :eager="true"
        :high="false"
        :alt="photo.title"
        :aspect="aspect"
      />
    </div>
    <p v-if="photo.status === 'failed'" class="state">
      处理失败<template v-if="photo.error">：{{ photo.error }}</template>
    </p>
    <p v-else-if="photo.status === 'processing' || photo.status === 'uploading'" class="state">处理中</p>
    <p v-if="photo.caption" class="caption">{{ photo.caption }}</p>

    <dl v-if="rows.length" class="exif">
      <div v-for="r in rows" :key="r.label">
        <dt>{{ r.label }}</dt>
        <dd>{{ r.value }}</dd>
      </div>
    </dl>
    <p v-else class="muted">没有拍摄参数</p>

    <section class="fields" :aria-labelledby="`${uid}-fields`">
      <h3 :id="`${uid}-fields`">公开字段</h3>
      <ul v-if="fields.length" class="chips">
        <li v-for="f in fields" :key="f.key" :data-public-field="f.key">{{ f.label }}</li>
      </ul>
      <p v-else class="muted">不公开拍摄参数</p>
    </section>

    <button type="button" class="delete" data-delete @click="emit('delete')">删除</button>
  </aside>
</template>

<style scoped>
.panel {
  position: fixed;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: var(--space-16);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-16);
  background: var(--bg-wall);
  color: var(--fg);
  /* Phones: bottom sheet. */
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 75vh;
  border-top: 1px solid var(--line);
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.5);
}
@media (min-width: 768px) {
  .panel {
    left: auto;
    top: 0;
    width: 400px;
    max-height: none;
    border-top: 0;
    border-left: 1px solid var(--line);
    box-shadow: none;
  }
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-12);
}
h2 {
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 1.25rem;
  word-break: break-word;
  padding-top: 8px;
}
h3 {
  font-size: 0.875rem;
  font-weight: 400;
  color: var(--fg-muted);
  margin-bottom: var(--space-8);
}
.image :deep(.cover) {
  max-height: 50vh;
}
.state {
  color: var(--fg);
}
.caption,
.muted {
  color: var(--fg-muted);
}
.exif {
  display: grid;
  gap: var(--space-4);
}
.exif div {
  display: flex;
  justify-content: space-between;
  gap: var(--space-12);
}
.exif dt {
  color: var(--fg-muted);
}
.exif dd {
  margin: 0;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-8);
  margin: 0;
  padding: 0;
  list-style: none;
}
.chips li {
  padding: 2px var(--space-8);
  border: 1px solid var(--line);
  font-size: 0.875rem;
}
button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  flex-shrink: 0;
}
.delete {
  align-self: flex-start;
  border-color: var(--fg-muted);
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
