<script setup lang="ts">
// Picks photos from the author's archive for the tools (spec §3).
// Shown only when signed in. Frame picks 1, collage picks 2–12.
import { computed, ref, shallowRef, watch } from 'vue'
import { getArchive } from '../api/me'
import { session } from '../api/session'
import type { ArchiveQuery, ArchiveFacets, OwnerPhoto } from '../api/types'
import ArchiveFilters from '../me/ArchiveFilters.vue'
import Cover from '../walls/Cover.vue'

const props = defineProps<{ maxPick: number }>()
const emit = defineEmits<{ pick: [photos: OwnerPhoto[]] }>()

const q = ref<ArchiveQuery>({ status: 'ready' })
const items = shallowRef<OwnerPhoto[]>([])
const facets = shallowRef<ArchiveFacets | null>(null)
const selected = ref<Set<string>>(new Set())
const state = ref<'idle' | 'loading' | 'error'>('idle')
let ctrl: AbortController | null = null

async function load() {
  ctrl?.abort()
  const c = (ctrl = new AbortController())
  state.value = 'loading'
  const r = await getArchive({ ...q.value, status: 'ready' }, null, c.signal)
  if (!r.ok) {
    if (r.status === -1) return
    state.value = 'error'
    return
  }
  items.value = r.data.items.filter(p => p.status === 'ready')
  facets.value = r.data.facets
  state.value = 'idle'
}

watch(q, () => { selected.value = new Set(); void load() }, { immediate: true })

function toggle(p: OwnerPhoto) {
  const s = new Set(selected.value)
  if (s.has(p.id)) s.delete(p.id)
  else if (s.size < props.maxPick) s.add(p.id)
  selected.value = s
}

function confirm() {
  const picked = items.value.filter(p => selected.value.has(p.id))
  if (picked.length > 0) emit('pick', picked)
}

const count = computed(() => selected.value.size)
</script>

<template>
  <aside v-if="session.user" class="archive-picker" aria-label="从归档选">
    <h2>从归档选</h2>
    <ArchiveFilters :q="q" :facets="facets" hide-status @update="v => (q = { ...v, status: 'ready' })" />
    <p v-if="state === 'loading'" role="status">载入中…</p>
    <p v-else-if="state === 'error'">加载失败</p>
    <ul v-else class="tiles" role="listbox" :aria-multiselectable="maxPick > 1 ? 'true' : undefined">
      <li
        v-for="p in items"
        :key="p.id"
        role="option"
        :aria-selected="selected.has(p.id) ? 'true' : 'false'"
        class="tile"
        :class="{ selected: selected.has(p.id) }"
        tabindex="0"
        @click="toggle(p)"
        @keydown.enter.prevent="toggle(p)"
        @keydown.space.prevent="toggle(p)"
      >
        <Cover :media="p.media" :sizes="'120px'" :eager="false" :high="false" :alt="p.title" :aspect="1" />
      </li>
    </ul>
    <div class="actions">
      <button type="button" :disabled="count === 0" @click="confirm">
        选好（{{ count }}{{ maxPick > 1 ? ` / ${maxPick}` : '' }}）
      </button>
    </div>
  </aside>
</template>

<style scoped>
.archive-picker { display: flex; flex-direction: column; gap: var(--space-12); padding: var(--space-16); border: 1px solid var(--line); background: var(--bg-wall); max-height: 60vh; overflow-y: auto; }
h2 { margin: 0; font-family: var(--font-title); font-weight: 400; font-size: 1rem; }
.tiles { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: var(--space-8); }
.tile { cursor: pointer; border: 2px solid transparent; }
.tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tile.selected { border-color: var(--accent); }
.actions { display: flex; gap: var(--space-8); }
button { min-height: 44px; padding: 0 var(--space-16); border: 1px solid var(--accent); background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
button:disabled { opacity: 0.45; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
</style>
