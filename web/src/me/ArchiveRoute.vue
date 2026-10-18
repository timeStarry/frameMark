<script setup lang="ts">
// `/me` (spec §5): the author's archive. Filters live in the URL query
// (router.replace, so Back leaves /me rather than stepping through filters);
// each change aborts the open requests and reloads from the first page.
// Paging mirrors the square: one guarded more() behind a sentinel and a
// 载入更多 button. Selecting a tile opens a non-modal detail panel; delete
// goes through the modal ConfirmDialog. Uploads (spec §6) come from the 上传
// button or a page-wide drop; finished photos are prepended to the grid.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ArchiveFacets, ArchiveQuery, OwnerPhoto } from '../api/types'
import { completeUpload, createUpload, deletePhoto, getArchive, getPhoto } from '../api/me'
import WallStatus from '../walls/WallStatus.vue'
import ArchiveFilters from './ArchiveFilters.vue'
import ArchiveGrid from './ArchiveGrid.vue'
import PhotoPanel from './PhotoPanel.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { fromRoute, isFiltered, toQuery } from './archiveQuery'
import UploadTray from './UploadTray.vue'
import { ACCEPT, createQueue, sleep, xhrPut } from './uploadQueue'
import { sha256Hex } from './sha256'

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

// --- Uploads ---

const ACCEPT_ATTR = ACCEPT.join(',')
const fileInput = ref<HTMLInputElement | null>(null)
const queue = createQueue({
  hash: sha256Hex,
  create: createUpload,
  complete: completeUpload,
  get: getPhoto,
  put: xhrPut,
  sleep,
  now: () => Date.now(),
})
queue.onDone((p) => {
  items.value = [p, ...items.value.filter((x) => x.id !== p.id)]
})

function pickFiles() {
  fileInput.value?.click()
}

function onFileChange(e: Event) {
  const el = e.target as HTMLInputElement
  if (el.files?.length) queue.add(Array.from(el.files))
  // Clearing lets the same file be chosen again (e.g. after a rejection).
  el.value = ''
}

// Page-wide drop: dragenter/dragleave fire per child element, so count them.
const dragging = ref(false)
let dragDepth = 0
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

function onDragEnter(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth++
  dragging.value = true
}
function onDragOver(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(e: DragEvent) {
  if (!hasFiles(e)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}
function onDrop(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dragging.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length) queue.add(files)
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('dragenter', onDragEnter)
  document.addEventListener('dragover', onDragOver)
  document.addEventListener('dragleave', onDragLeave)
  document.addEventListener('drop', onDrop)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('dragenter', onDragEnter)
  document.removeEventListener('dragover', onDragOver)
  document.removeEventListener('dragleave', onDragLeave)
  document.removeEventListener('drop', onDrop)
  queue.dispose()
  io?.disconnect()
  ctrl?.abort()
  moreCtrl?.abort()
  document.title = 'Markr'
})

void load()
</script>

<template>
  <main ref="root" class="archive" :class="{ 'has-panel': selected }" :aria-labelledby="`${uid}-title`">
    <div class="head">
      <h1 :id="`${uid}-title`" ref="heading" tabindex="-1">归档</h1>
      <button type="button" class="upload" @click="pickFiles">上传</button>
    </div>
    <input
      ref="fileInput"
      type="file"
      multiple
      :accept="ACCEPT_ATTR"
      hidden
      tabindex="-1"
      @change="onFileChange"
    />
    <UploadTray :items="queue.items" @retry="queue.retry" @clear="queue.clearFinished" />
    <ArchiveFilters :q="q" :facets="facets" @update="onFilters" />

    <template v-if="state === 'idle'">
      <div v-if="items.length === 0" class="empty">
        <template v-if="isFiltered(q)">
          <p>没有符合筛选的照片</p>
        </template>
        <template v-else>
          <p>还没有照片</p>
          <div data-upload-slot class="upload-slot">
            <button type="button" class="upload" @click="pickFiles">上传</button>
          </div>
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
    <div v-if="dragging" data-drop-overlay class="drop" aria-hidden="true">松开以上传</div>
  </main>
</template>

<style scoped>
.archive {
  max-width: 1440px;
  margin: 0 auto;
  padding: var(--space-24) max(16px, 4vw) var(--space-48);
}
/* Phones: the bottom sheet is up to 75vh tall; let the last rows scroll above it. */
@media (max-width: 767px) {
  .archive.has-panel {
    padding-bottom: calc(75vh + var(--space-16));
  }
}
@media (min-width: 768px) {
  .archive.has-panel {
    padding-right: calc(400px + var(--space-16));
  }
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-16);
}
.upload {
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
.upload:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
.drop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--accent);
  background: rgba(11, 11, 12, 0.85);
  color: var(--fg);
  font-family: var(--font-title);
  font-size: 1.5rem;
  pointer-events: none;
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
