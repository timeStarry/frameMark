<script setup lang="ts">
// The archive filter bar (spec §5). Stateless: shows `q`, emits the next
// query; the route writes it to the URL. Options and counts come from facets.
import { computed, useId } from 'vue'
import type { ArchiveFacets, ArchiveQuery, PhotoStatus } from '../api/types'
import { isFiltered } from './archiveQuery'

const props = defineProps<{
  q: ArchiveQuery
  facets: ArchiveFacets | null
  /** The desk lists only ready photos, so it hides the status filter. */
  hideStatus?: boolean
}>()
const emit = defineEmits<{ update: [q: ArchiveQuery] }>()

const id = useId()
const STATUS_OPTIONS: { value: '' | PhotoStatus; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'processing', label: '处理中' },
  { value: 'failed', label: '失败' },
]

type Opt = { value: string; label: string }
/** Facet options; a URL value missing from the facets still shows as selected. */
function options(list: { key: string; count: number }[], current: string | undefined): Opt[] {
  const out: Opt[] = list.map((f) => ({ value: f.key, label: `${f.key}（${f.count}）` }))
  if (current !== undefined && current !== '' && !list.some((f) => f.key === current)) {
    out.unshift({ value: current, label: current })
  }
  return out
}

const years = computed(() =>
  options(
    (props.facets?.years ?? []).map((y) => ({ key: String(y.year), count: y.count })),
    props.q.year === undefined ? undefined : String(props.q.year),
  ),
)
const cameras = computed(() => options((props.facets?.cameras ?? []).map((c) => ({ key: c.name, count: c.count })), props.q.camera))
const lenses = computed(() => options((props.facets?.lenses ?? []).map((c) => ({ key: c.name, count: c.count })), props.q.lens))

function patch(p: Partial<ArchiveQuery>) {
  const next: ArchiveQuery = { ...props.q, ...p }
  for (const k of Object.keys(next) as (keyof ArchiveQuery)[]) {
    if (next[k] === undefined) delete next[k]
  }
  emit('update', next)
}

const val = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value

function onYear(e: Event) {
  const v = val(e)
  patch({ year: v === '' ? undefined : Number(v) })
}
function onText(key: 'camera' | 'lens', e: Event) {
  const v = val(e)
  patch({ [key]: v === '' ? undefined : v })
}
function onFocal(key: 'focalMin' | 'focalMax', e: Event) {
  const raw = val(e).trim()
  if (raw === '') return patch({ [key]: undefined })
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return
  patch({ [key]: n })
}
function onUnused(e: Event) {
  patch({ inCollection: (e.target as HTMLInputElement).checked ? false : undefined })
}
function onStatus(e: Event) {
  const v = val(e)
  patch({ status: v === '' ? undefined : (v as PhotoStatus) })
}
</script>

<template>
  <form class="filters" aria-label="筛选" @submit.prevent>
    <div class="field">
      <label :for="`${id}-year`">年份</label>
      <select :id="`${id}-year`" name="year" :value="q.year === undefined ? '' : String(q.year)" @change="onYear">
        <option value="">全部</option>
        <option v-for="o in years" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div class="field">
      <label :for="`${id}-camera`">机身</label>
      <select :id="`${id}-camera`" name="camera" :value="q.camera ?? ''" @change="onText('camera', $event)">
        <option value="">全部</option>
        <option v-for="o in cameras" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div class="field">
      <label :for="`${id}-lens`">镜头</label>
      <select :id="`${id}-lens`" name="lens" :value="q.lens ?? ''" @change="onText('lens', $event)">
        <option value="">全部</option>
        <option v-for="o in lenses" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div class="field focal">
      <label :for="`${id}-fmin`">最小焦段（mm）</label>
      <input
        :id="`${id}-fmin`"
        name="focal_min"
        type="number"
        inputmode="decimal"
        min="1"
        step="any"
        :value="q.focalMin ?? ''"
        @change="onFocal('focalMin', $event)"
      />
    </div>
    <div class="field focal">
      <label :for="`${id}-fmax`">最大焦段（mm）</label>
      <input
        :id="`${id}-fmax`"
        name="focal_max"
        type="number"
        inputmode="decimal"
        min="1"
        step="any"
        :value="q.focalMax ?? ''"
        @change="onFocal('focalMax', $event)"
      />
    </div>
    <div v-if="!hideStatus" class="field">
      <label :for="`${id}-status`">状态</label>
      <select :id="`${id}-status`" name="status" :value="q.status ?? ''" @change="onStatus">
        <option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div class="field check">
      <input :id="`${id}-unused`" name="unused" type="checkbox" :checked="q.inCollection === false" @change="onUnused" />
      <label :for="`${id}-unused`">未用于合集</label>
    </div>
    <button v-if="isFiltered(q)" type="button" class="clear" @click="emit('update', {})">清除筛选</button>
  </form>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-12) var(--space-16);
  padding: var(--space-16) 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}
.field.check {
  flex-direction: row;
  align-items: center;
  gap: var(--space-8);
  min-height: 44px;
}
label {
  color: var(--fg-muted);
  font-size: 0.875rem;
}
.check label {
  color: var(--fg);
  font-size: 1rem;
  cursor: pointer;
}
select,
input[type='number'] {
  min-height: 44px;
  max-width: 100%;
  padding: 0 var(--space-8);
  border: 1px solid var(--line);
  border-radius: 0;
  background: var(--bg-wall);
  color: var(--fg);
}
select {
  max-width: 14rem;
}
.focal input {
  width: 8rem;
}
input[type='checkbox'] {
  width: 24px;
  height: 24px;
  margin: 10px;
  accent-color: var(--accent);
}
.clear {
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
select:focus-visible,
input:focus-visible,
.clear:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
