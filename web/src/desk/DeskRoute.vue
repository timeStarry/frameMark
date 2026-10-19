<script setup lang="ts">
// `/me/c/:id` — the curation desk (spec §4.1–4.6, §5). Three columns at
// ≥1100px: archive, sequence, and the right column (访客视角, or the property
// slot while a frame is selected). 768–1099px: sequence + right column, the
// archive slides in as a drawer behind 「添加照片」. The phone layout is Task 9.
// All edits go through useDesk: the columns compute the next Seq with the pure
// ops in sequence.ts and this route applies it as a structural edit.
import { computed, onBeforeUnmount, onMounted, ref, toRef, useId } from 'vue'
import { RouterLink } from 'vue-router'
import { usePageHeading } from '../me/pageHeading'
import WallStatus from '../walls/WallStatus.vue'
import DeskArchive from './DeskArchive.vue'
import DeskPreview from './DeskPreview.vue'
import DeskSequence from './DeskSequence.vue'
import { insertPhotos, photoIds, type DeskPhoto, type Seq } from './sequence'
import { useDesk, type SaveState } from './useDesk'

const props = defineProps<{ id: string }>()

const desk = useDesk(toRef(props, 'id'))
const uid = useId()
const heading = ref<HTMLElement | null>(null)
const title = computed(() => (desk.state.value === 'ready' ? desk.fields.value.title || '策展台' : '策展台'))
usePageHeading(heading, () => title.value)

const seq = desk.seq
const inSequence = computed(() => photoIds(seq.value))
const archive = ref<InstanceType<typeof DeskArchive> | null>(null)
const sequence = ref<InstanceType<typeof DeskSequence> | null>(null)

// --- Announcements (aria-live="polite") ---

const announcement = ref('')
function announce(msg: string) {
  // Clearing first makes a repeated message speak again.
  announcement.value = ''
  void Promise.resolve().then(() => (announcement.value = msg))
}

// --- Edits ---

const UNDO_MS = 8000
const undoToast = ref(false)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function hideToast() {
  undoToast.value = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = null
}

function showUndoToast() {
  hideToast()
  undoToast.value = true
  toastTimer = setTimeout(hideToast, UNDO_MS)
}

function onEdit(next: Seq, message: string, removed = false) {
  desk.applySeq(next, 'structure')
  // applySeq may defer the edit behind an open exposure check; the message
  // still describes what was asked for.
  announce(message)
  if (removed) showUndoToast()
  else hideToast()
  if (desk.selected.value >= next.length) desk.selected.value = Math.max(0, next.length - 1)
}

/**
 * Appends archive photos, one full frame each (Enter / 加入).
 * Local helper: belongs in useDesk as an `append(photos)` action later.
 */
function appendPhotos(photos: DeskPhoto[]) {
  const s = seq.value
  const next = insertPhotos(s, s.length, photos)
  if (next === s) {
    announce('合集最多 200 帧')
    return
  }
  onEdit(next, photos.length === 1 ? `已加入到第 ${next.length} 帧` : `已加入 ${photos.length} 帧`)
}

function undo() {
  if (!desk.canUndo.value) return
  desk.undo()
  hideToast()
  announce('已撤销')
}

function redo() {
  if (!desk.canRedo.value) return
  desk.redo()
  announce('已重做')
}

function undoDelete() {
  hideToast()
  undo()
}

// --- Selection and the right column ---

/** A frame is "selected" (property slot open) only after Enter / click. */
const panelOpen = ref(false)

function onFocusFrame(i: number) {
  desk.selected.value = i
}

function onSelect(i: number) {
  desk.selected.value = i
  panelOpen.value = true
}

function closePanel() {
  panelOpen.value = false
  sequence.value?.focusIndex(desk.selected.value)
}

const initialFrame = computed(() => Math.min(Math.max(desk.selected.value, 0), Math.max(seq.value.length - 1, 0)) + 1)

// --- Archive drawer (768–1099px) ---

const drawerOpen = ref(false)

function fromArchive() {
  drawerOpen.value = true
  void archive.value?.focusFirst()
}

// --- Keyboard: undo/redo everywhere except text entry; Esc closes the slot ---

function isTextEntry(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  return t.closest('input, textarea, select') !== null
}

function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) return
  const mod = e.metaKey || e.ctrlKey
  if (mod && !e.altKey && !isTextEntry(e.target)) {
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault()
      undo()
      return
    }
    if ((k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey)) {
      e.preventDefault()
      redo()
      return
    }
  }
  if (e.key === 'Escape' && !mod) {
    if (panelOpen.value) {
      e.preventDefault()
      closePanel()
    } else if (drawerOpen.value) {
      e.preventDefault()
      drawerOpen.value = false
    }
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  hideToast()
})

// --- Top bar ---

const SAVE_LABEL: Record<SaveState, string> = {
  saved: '已保存',
  saving: '保存中…',
  unsaved: '未保存',
  error: '未保存·重试',
  conflict: '有冲突，未保存',
}
const saveLabel = computed(() => SAVE_LABEL[desk.saveState.value])
</script>

<template>
  <main class="desk" :aria-labelledby="`${uid}-title`">
    <header class="bar">
      <RouterLink class="back" to="/me/collections">返回我的合集</RouterLink>
      <h1 :id="`${uid}-title`" ref="heading" tabindex="-1">{{ title }}</h1>
      <p class="save" role="status" :data-save="desk.saveState.value">
        {{ desk.state.value === 'ready' ? saveLabel : '' }}
        <span v-if="desk.state.value === 'ready' && desk.errorMessage.value" class="save-error">{{ desk.errorMessage.value }}</span>
      </p>
      <div v-if="desk.state.value === 'ready'" class="tools">
        <button type="button" :disabled="!desk.canUndo.value" @click="undo">撤销</button>
        <button type="button" :disabled="!desk.canRedo.value" @click="redo">重做</button>
        <button type="button" class="drawer-btn" :aria-expanded="drawerOpen ? 'true' : 'false'" @click="drawerOpen = !drawerOpen">
          添加照片
        </button>
      </div>
    </header>

    <template v-if="desk.state.value === 'ready'">
      <div class="cols">
        <div class="col archive-col" :class="{ open: drawerOpen }">
          <DeskArchive ref="archive" :in-sequence="inSequence" @add="appendPhotos" />
        </div>
        <div class="col seq-col">
          <DeskSequence
            ref="sequence"
            :seq="seq"
            :selected="desk.selected.value"
            @edit="onEdit"
            @refuse="announce"
            @focus="onFocusFrame"
            @select="onSelect"
            @from-archive="fromArchive"
          />
        </div>
        <div class="col right-col">
          <aside v-if="panelOpen" class="props" :aria-labelledby="`${uid}-props`" data-desk-props>
            <h2 :id="`${uid}-props`">属性</h2>
            <p class="muted">第 {{ desk.selected.value + 1 }} 帧</p>
            <button type="button" @click="closePanel">返回访客视角</button>
          </aside>
          <DeskPreview v-else :collection="desk.previewCollection.value" :initial-frame="initialFrame" />
        </div>
      </div>
    </template>
    <p v-else-if="desk.state.value === 'missing'" class="status">找不到这个合集</p>
    <p v-else-if="desk.state.value === 'error'" class="status">网络连接出了问题，请刷新页面重试</p>
    <WallStatus v-else state="loading" />

    <div v-if="desk.exposure.value" class="exposure" role="alertdialog" :aria-labelledby="`${uid}-exp`" data-desk-exposure>
      <h2 :id="`${uid}-exp`">这次修改会让访客看到更多内容</h2>
      <ul>
        <li v-for="(c, i) in desk.exposure.value.changes" :key="i">{{ c.detail }}</li>
      </ul>
      <div class="actions">
        <button type="button" @click="desk.exposure.value.cancel()">撤销这次修改</button>
        <button type="button" @click="desk.exposure.value.confirm()">确认并保存</button>
      </div>
    </div>

    <div v-if="undoToast" class="toast" data-undo-toast>
      <span>已删除一帧</span>
      <button type="button" @click="undoDelete">撤销</button>
    </div>
    <div class="sr-only" aria-live="polite" aria-atomic="true" data-desk-live>{{ announcement }}</div>
  </main>
</template>

<style scoped>
.desk {
  padding: var(--space-16) max(16px, 2vw) var(--space-48);
}
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-12) var(--space-16);
  padding-bottom: var(--space-16);
  border-bottom: 1px solid var(--line);
}
.back {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: var(--fg-muted);
  text-decoration: none;
}
.back:focus-visible,
button:focus-visible,
h1:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
h1 {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 1.25rem;
}
.save {
  margin: 0;
  color: var(--fg-muted);
}
.save-error {
  margin-left: var(--space-8);
  color: var(--fg);
}
.tools,
.actions {
  display: flex;
  gap: var(--space-8);
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
.cols {
  display: grid;
  gap: var(--space-24);
  padding-top: var(--space-16);
  grid-template-columns: 320px minmax(0, 1fr) 400px;
}
.right-col {
  position: sticky;
  top: var(--space-16);
  align-self: start;
  height: calc(100vh - 2 * var(--space-16));
}
.drawer-btn {
  display: none;
}
@media (max-width: 1099px) {
  .cols {
    grid-template-columns: minmax(0, 1fr) 360px;
  }
  .drawer-btn {
    display: inline-block;
  }
  .archive-col {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 40;
    width: min(360px, 90vw);
    padding: var(--space-16);
    overflow-y: auto;
    background: var(--bg-wall);
    border-right: 1px solid var(--line);
    transform: translateX(-100%);
    visibility: hidden;
    transition: transform var(--dur-move) var(--ease-move), visibility 0s linear var(--dur-move);
  }
  .archive-col.open {
    transform: none;
    visibility: visible;
    transition: transform var(--dur-move) var(--ease-move);
  }
}
@media (prefers-reduced-motion: reduce) {
  .archive-col {
    transition: none !important;
  }
}
.props {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-12);
}
.props h2,
.exposure h2 {
  margin: 0;
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 1.125rem;
}
.muted,
.status {
  margin: 0;
  color: var(--fg-muted);
}
.status {
  padding: var(--space-48) 0;
  text-align: center;
}
.exposure {
  position: fixed;
  left: 50%;
  top: 20vh;
  z-index: 60;
  width: min(420px, calc(100vw - 32px));
  padding: var(--space-24);
  transform: translateX(-50%);
  border: 1px solid var(--line);
  background: var(--bg-wall);
}
.toast {
  position: fixed;
  left: 50%;
  bottom: var(--space-24);
  z-index: 50;
  display: flex;
  align-items: center;
  gap: var(--space-12);
  padding: var(--space-8) var(--space-8) var(--space-8) var(--space-16);
  transform: translateX(-50%);
  border: 1px solid var(--line);
  background: var(--bg-wall);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
</style>
