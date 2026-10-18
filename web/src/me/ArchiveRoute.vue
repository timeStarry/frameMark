<script setup lang="ts">
// `/me` (spec §5): the author's archive. Filters live in the URL query
// (router.replace, so Back leaves /me rather than stepping through filters);
// each change aborts the open requests and reloads from the first page.
// Paging mirrors the square: one guarded more() behind a sentinel and a
// 载入更多 button. Selecting a tile opens a non-modal detail panel; delete
// goes through the modal ConfirmDialog.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ArchiveFacets, ArchiveQuery, OwnerPhoto } from '../api/types'
import { deletePhoto, getArchive } from '../api/me'
import WallStatus from '../walls/WallStatus.vue'
import ArchiveFilters from './ArchiveFilters.vue'
import ArchiveGrid from './ArchiveGrid.vue'
import PhotoPanel from './PhotoPanel.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { fromRoute, isFiltered, toQuery } from './archiveQuery'

const route = useRoute()
const router = useRouter()
const ownName = route.name
const uid = useId()
const panelId = `${uid}-panel`

document.title = '归档 — Markr'

const q = computed<ArchiveQuery>(() => fromRoute(route.query))
const items = shallowRef<OwnerPhoto[]>([])
const facets = shallowRef<ArchiveFacets | null>(null)
const nextCursor = ref<string | null>(null)
const state = ref<'loading' | 'error' | 'idle'>('loading')
const root = ref<HTMLElement | null>(null)
const heading = ref<HTMLElement | null>(null)

// --- First page ---

let ctrl: AbortController | null = null
let moreCtrl: AbortController | null = null

async function load() {
  ctrl?.abort()
  moreCtrl?.abort()
  moreState.value = 'idle'
  const c = new AbortController()
  ctrl = c
  state.value = 'loading'
  const r = await getArchive(q.value, null, c.signal)
  if (c.signal.aborted) return
  if (!r.ok) {
    if (r.status !== -1) state.value = 'error'
    return
  }
  items.value = r.data.items
  facets.value = r.data.facets
  nextCursor.value = r.data.nextCursor
  state.value = 'idle'
  // A selected photo that the new filter dropped closes its panel.
  if (selectedId.value && !r.data.items.some((p) => p.id === selectedId.value)) selectedId.value = null
}

watch(
  () => JSON.stringify(q.value),
  () => {
    if (route.name === ownName) void load()
  },
)

function onFilters(next: ArchiveQuery) {
  void router.replace({ query: toQuery(next) })
}

// --- Next pages ---

const moreState = ref<'idle' | 'loading' | 'error'>('idle')

async function more() {
  const cursor = nextCursor.value
  if (!cursor || moreState.value === 'loading' || state.value !== 'idle') return
  moreState.value = 'loading'
  const c = new AbortController()
  moreCtrl = c
  const r = await getArchive(q.value, cursor, c.signal)
  if (c.signal.aborted) return
  if (!r.ok) {
    moreState.value = r.status === -1 ? 'idle' : 'error'
    return
  }
  const known = new Set(items.value.map((p) => p.id))
  items.value = [...items.value, ...r.data.items.filter((p) => !known.has(p.id))]
  nextCursor.value = r.data.nextCursor
  moreState.value = 'idle'
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
    { rootMargin: '800px 0px' },
  )
  io.observe(el)
})

// --- Panel ---

const selectedId = ref<string | null>(null)
const selected = computed(() => items.value.find((p) => p.id === selectedId.value) ?? null)

function tileEl(id: string): HTMLElement | null {
  return root.value?.querySelector<HTMLElement>(`button[data-photo-id="${CSS.escape(id)}"]`) ?? null
}

function select(id: string) {
  selectedId.value = id
}

async function closePanel() {
  const id = selectedId.value
  selectedId.value = null
  if (!id) return
  await nextTick()
  tileEl(id)?.focus()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !selectedId.value || dialogOpen.value || e.defaultPrevented) return
  e.preventDefault()
  void closePanel()
}

// --- Delete ---

const dialogOpen = ref(false)
const deleting = ref(false)
const deleteError = ref('')
const DELETE_BODY = '如果它在已发布的合集中，访客会立刻看不到。'

function askDelete() {
  deleteError.value = ''
  dialogOpen.value = true
}

async function cancelDelete() {
  if (deleting.value) return
  dialogOpen.value = false
  deleteError.value = ''
  await nextTick()
  root.value?.querySelector<HTMLElement>('[data-delete]')?.focus()
}

async function confirmDelete() {
  const id = selectedId.value
  if (!id || deleting.value) return
  deleting.value = true
  deleteError.value = ''
  const r = await deletePhoto(id)
  deleting.value = false
  if (!r.ok) {
    deleteError.value = r.message
    return
  }
  const list = items.value
  const i = list.findIndex((p) => p.id === id)
  const next = list[i + 1] ?? list[i - 1] ?? null
  items.value = list.filter((p) => p.id !== id)
  dialogOpen.value = false
  selectedId.value = null
  await nextTick()
  const target = next ? tileEl(next.id) : null
  if (target) target.focus()
  else heading.value?.focus()
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  io?.disconnect()
  ctrl?.abort()
  moreCtrl?.abort()
  document.title = 'Markr'
})

void load()
</script>

<template>
  <main ref="root" class="archive" :class="{ 'has-panel': selected }" :aria-labelledby="`${uid}-title`">
    <h1 :id="`${uid}-title`" ref="heading" tabindex="-1">归档</h1>
    <ArchiveFilters :q="q" :facets="facets" @update="onFilters" />

    <template v-if="state === 'idle'">
      <div v-if="items.length === 0" class="empty">
        <template v-if="isFiltered(q)">
          <p>没有符合筛选的照片</p>
        </template>
        <template v-else>
          <p>还没有照片</p>
          <!-- Task 6 mounts the upload button here. -->
          <div data-upload-slot class="upload-slot" />
        </template>
      </div>
      <template v-else>
        <ArchiveGrid :items="items" :selected-id="selectedId" :panel-id="panelId" @select="select" />
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

    <PhotoPanel v-if="selected" :key="selected.id" :photo="selected" :panel-id="panelId" @close="closePanel" @delete="askDelete" />
    <ConfirmDialog
      title="删除这张照片？"
      :body="DELETE_BODY"
      confirm-label="删除"
      :open="dialogOpen"
      :error="deleteError"
      :busy="deleting"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </main>
</template>

<style scoped>
.archive {
  max-width: 1440px;
  margin: 0 auto;
  padding: var(--space-24) max(16px, 4vw) var(--space-48);
}
@media (min-width: 768px) {
  .archive.has-panel {
    padding-right: calc(400px + var(--space-16));
  }
}
h1 {
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 1.5rem;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-16);
  padding: var(--space-48) 0;
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
  padding: var(--space-24) 0;
}
.more button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
.more button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
</style>
