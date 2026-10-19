<script setup lang="ts">
// The desk's archive column (spec §4.2). Filters are local state (never the
// URL) and the request always asks for ready photos only. Tiles are options of
// a multi-select listbox: click selects one, ⌘/Ctrl click toggles, Shift click
// selects a range, Space toggles the focused tile, Enter or 加入 appends the
// selection (or the focused tile) to the sequence. Tiles drag as
// application/x-markr-photo. Photos already in the sequence are dimmed and
// marked 已在序列, and can still be added again.
// Paging mirrors the SP4a archive: one guarded more() behind a sentinel and a
// 载入更多 button.
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { getArchive } from '../api/me'
import type { ArchiveFacets, ArchiveQuery, OwnerPhoto } from '../api/types'
import ArchiveFilters from '../me/ArchiveFilters.vue'
import Cover from '../walls/Cover.vue'
import WallStatus from '../walls/WallStatus.vue'
import { writePhotos } from './dnd'
import type { DeskPhoto } from './sequence'

/** `locked`: an exposure check is pending; adding (and dragging out) is off. */
const props = defineProps<{ inSequence: ReadonlySet<string>; locked?: boolean }>()
const emit = defineEmits<{ add: [photos: DeskPhoto[]] }>()

const uid = useId()
const TILE_TIERS = ['w480'] as const

const q = ref<ArchiveQuery>({})
const items = shallowRef<OwnerPhoto[]>([])
const facets = shallowRef<ArchiveFacets | null>(null)
const nextCursor = ref<string | null>(null)
const state = ref<'loading' | 'error' | 'idle'>('loading')
const moreState = ref<'idle' | 'loading' | 'error'>('idle')
const root = ref<HTMLElement | null>(null)

/** The desk only arranges ready photos; the backend accepts status=ready. */
const request = computed<ArchiveQuery>(() => ({ ...q.value, status: 'ready' }))

let ctrl: AbortController | null = null
let moreCtrl: AbortController | null = null

async function load() {
  ctrl?.abort()
  moreCtrl?.abort()
  moreState.value = 'idle'
  const c = new AbortController()
  ctrl = c
  state.value = 'loading'
  const r = await getArchive(request.value, null, c.signal)
  if (c.signal.aborted) return
  if (!r.ok) {
    if (r.status !== -1) state.value = 'error'
    return
  }
  items.value = r.data.items.filter((p) => p.status === 'ready')
  facets.value = r.data.facets
  nextCursor.value = r.data.nextCursor
  state.value = 'idle'
  const known = new Set(items.value.map((p) => p.id))
  selection.value = new Set([...selection.value].filter((id) => known.has(id)))
}

async function more() {
  const cursor = nextCursor.value
  if (!cursor || moreState.value === 'loading' || state.value !== 'idle') return
  moreState.value = 'loading'
  const c = new AbortController()
  moreCtrl = c
  const r = await getArchive(request.value, cursor, c.signal)
  if (c.signal.aborted) return
  if (!r.ok) {
    moreState.value = r.status === -1 ? 'idle' : 'error'
    return
  }
  const known = new Set(items.value.map((p) => p.id))
  items.value = [...items.value, ...r.data.items.filter((p) => p.status === 'ready' && !known.has(p.id))]
  nextCursor.value = r.data.nextCursor
  moreState.value = 'idle'
}

function onFilters(next: ArchiveQuery) {
  if (JSON.stringify(next) === JSON.stringify(q.value)) return
  q.value = next
  void load()
}

const sentinel = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null
watch(sentinel, (el) => {
  io?.disconnect()
  io = null
  if (!el || typeof IntersectionObserver !== 'function') return
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && moreState.value === 'idle') void more()
    },
    { rootMargin: '400px 0px' },
  )
  io.observe(el)
})

// --- Selection ---

const selection = ref<Set<string>>(new Set())
let anchor: string | null = null

function toDesk(p: OwnerPhoto): DeskPhoto {
  return { id: p.id, title: p.title, media: p.media, width: p.width, height: p.height }
}

/** Selected photos in archive order. */
const selectedPhotos = computed(() => items.value.filter((p) => selection.value.has(p.id)))

function onTileClick(p: OwnerPhoto, e: MouseEvent) {
  const next = new Set(selection.value)
  if (e.shiftKey && anchor) {
    const ids = items.value.map((x) => x.id)
    const a = ids.indexOf(anchor)
    const b = ids.indexOf(p.id)
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      for (const id of ids.slice(lo, hi + 1)) next.add(id)
    }
  } else if (e.metaKey || e.ctrlKey) {
    if (next.has(p.id)) next.delete(p.id)
    else next.add(p.id)
    anchor = p.id
  } else {
    next.clear()
    next.add(p.id)
    anchor = p.id
  }
  selection.value = next
}

function toggle(p: OwnerPhoto) {
  const next = new Set(selection.value)
  if (next.has(p.id)) next.delete(p.id)
  else next.add(p.id)
  anchor = p.id
  selection.value = next
}

function addSelection(fallback?: OwnerPhoto) {
  if (props.locked) return
  const list = selectedPhotos.value.length > 0 ? selectedPhotos.value : fallback ? [fallback] : []
  if (list.length === 0) return
  emit('add', list.map(toDesk))
  selection.value = new Set()
}

function tiles(): HTMLElement[] {
  return Array.from(root.value?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
}

function onTileKey(p: OwnerPhoto, i: number, e: KeyboardEvent) {
  if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey) return
  switch (e.key) {
    case ' ':
    case 'Spacebar':
      e.preventDefault()
      toggle(p)
      return
    case 'Enter':
      e.preventDefault()
      addSelection(p)
      return
    case 'ArrowRight':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowUp': {
      e.preventDefault()
      const list = tiles()
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
      list[Math.min(list.length - 1, Math.max(0, i + step))]?.focus()
      return
    }
  }
}

function onDragStart(p: OwnerPhoto, e: DragEvent) {
  if (props.locked) {
    e.preventDefault()
    return
  }
  if (!e.dataTransfer) return
  // Dragging a selected tile carries the whole selection.
  const list = selection.value.has(p.id) ? selectedPhotos.value : [p]
  writePhotos(e.dataTransfer, list.map(toDesk))
}

function label(p: OwnerPhoto): string {
  const title = p.title.trim() || '无标题'
  return props.inSequence.has(p.id) ? `${title}，已在序列` : title
}

/** Focus the first tile (从归档添加), or the column when it has none. */
async function focusFirst() {
  await nextTick()
  const first = tiles()[0]
  if (first) first.focus()
  else root.value?.focus()
}

defineExpose({ focusFirst })

onBeforeUnmount(() => {
  io?.disconnect()
  ctrl?.abort()
  moreCtrl?.abort()
})

void load()
</script>

<template>
  <section ref="root" class="desk-archive" :aria-labelledby="`${uid}-h`" tabindex="-1">
    <div class="head">
      <h2 :id="`${uid}-h`">归档</h2>
      <button type="button" class="add" :disabled="locked || selectedPhotos.length === 0" @click="addSelection()">
        加入<template v-if="selectedPhotos.length > 0">（{{ selectedPhotos.length }}）</template>
      </button>
    </div>
    <ArchiveFilters :q="q" :facets="facets" hide-status @update="onFilters" />
    <template v-if="state === 'idle'">
      <p v-if="items.length === 0" class="empty">没有可加入的照片</p>
      <template v-else>
        <ul class="tiles" role="listbox" aria-multiselectable="true" :aria-labelledby="`${uid}-h`">
          <li
            v-for="(p, i) in items"
            :key="p.id"
            role="option"
            tabindex="0"
            :draggable="locked ? 'false' : 'true'"
            class="tile"
            :class="{ used: inSequence.has(p.id), selected: selection.has(p.id) }"
            :data-photo-id="p.id"
            :aria-selected="selection.has(p.id) ? 'true' : 'false'"
            :aria-label="label(p)"
            @click="onTileClick(p, $event)"
            @keydown="onTileKey(p, i, $event)"
            @dragstart="onDragStart(p, $event)"
          >
            <Cover :media="p.media" sizes="140px" :eager="false" :high="false" alt="" :aspect="1" :tiers="TILE_TIERS" />
            <span v-if="inSequence.has(p.id)" class="badge" aria-hidden="true">已在序列</span>
          </li>
        </ul>
        <template v-if="nextCursor">
          <WallStatus :state="moreState" @retry="more" />
          <div ref="sentinel" class="sentinel" aria-hidden="true" />
          <p v-if="moreState === 'idle'" class="more">
            <button type="button" @click="more">载入更多</button>
          </p>
        </template>
      </template>
    </template>
    <WallStatus v-else :state="state" @retry="load" />
  </section>
</template>

<style scoped>
.desk-archive {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
  min-width: 0;
}
.desk-archive:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-8);
}
h2 {
  margin: 0;
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 1.125rem;
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
button:disabled {
  cursor: default;
  opacity: 0.6;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: var(--space-8);
  margin: 0;
  padding: 0;
  list-style: none;
}
.tile {
  position: relative;
  min-height: 44px;
  cursor: grab;
  outline: none;
}
.tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.tile.selected {
  box-shadow: 0 0 0 2px var(--fg);
}
.tile.used :deep(.cover) {
  opacity: 0.4;
}
.badge {
  position: absolute;
  left: var(--space-4);
  bottom: var(--space-4);
  padding: 0 var(--space-4);
  background: rgba(11, 11, 12, 0.85);
  color: var(--fg);
  font-size: 0.75rem;
  line-height: 18px;
}
.empty {
  margin: 0;
  padding: var(--space-24) 0;
  color: var(--fg-muted);
  text-align: center;
}
.sentinel {
  height: 1px;
}
.more {
  display: flex;
  justify-content: center;
  margin: 0;
}
</style>
