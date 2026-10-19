<script setup lang="ts">
// The phone desk (<768px, spec §4.7). One column: reorder with 上移 / 下移,
// 删除, switch layout, edit the collection title and each frame's first photo
// title, publish / unpublish. No archive, no drag and drop, no preview.
// Owns no state: every edit goes through `desk`, so switching breakpoints in
// DeskRoute keeps everything. Publish / unpublish are emitted; DeskRoute opens
// the confirmation dialogs.
import { computed, ref, useId } from 'vue'
import type { FrameLayout } from '../api/types'
import Cover from '../walls/Cover.vue'
import { LAYOUT_LABEL, frameLabel, textPreview } from './labels'
import { allowedLayouts, move, remove, setLayout, type DeskFrame } from './sequence'
import type { Desk, SaveState } from './useDesk'

const props = defineProps<{ desk: Desk }>()
const emit = defineEmits<{ publish: []; unpublish: [] }>()

const uid = useId()
const desk = props.desk
const seq = desk.seq

/** Same lock as DeskRoute: an exposure check in flight or its dialog open. */
const locked = computed(() => desk.checking.value || desk.exposure.value !== null)
const published = computed(() => desk.collection.value?.status === 'published')

// Mirrors DeskRoute's map; labels.ts does not export save-state labels.
const SAVE_LABEL: Record<SaveState, string> = {
  saved: '已保存',
  saving: '保存中…',
  unsaved: '未保存',
  // The adjacent 重试 button completes 「未保存·重试」.
  error: '未保存 ·',
  conflict: '有冲突，未保存',
}
const saveLabel = computed(() => SAVE_LABEL[desk.saveState.value])

// --- Announcements (aria-live="polite") ---

const announcement = ref('')
function announce(msg: string) {
  // Clearing first makes a repeated message speak again.
  announcement.value = ''
  void Promise.resolve().then(() => (announcement.value = msg))
}

// --- Structural edits ---

function moveFrame(i: number, delta: -1 | 1) {
  if (locked.value) return
  const s = seq.value
  const to = i + delta
  const next = move(s, i, to)
  if (next === s) return
  desk.applySeq(next, 'structure')
  if (desk.selected.value === i) desk.selected.value = to
  announce(`已移到第 ${to + 1} 帧`)
}

function removeFrame(i: number) {
  if (locked.value) return
  const s = seq.value
  const next = remove(s, i)
  if (next === s) return
  desk.applySeq(next, 'structure')
  if (desk.selected.value >= next.length) desk.selected.value = Math.max(0, next.length - 1)
  announce(`已删除第 ${i + 1} 帧`)
}

function changeLayout(i: number, e: Event) {
  if (locked.value) return
  const layout = (e.target as HTMLSelectElement).value as FrameLayout
  const s = seq.value
  const next = setLayout(s, i, layout)
  if (next === s) return
  desk.applySeq(next, 'structure')
}

// --- Text fields ---

function changeCollectionTitle(e: Event) {
  if (locked.value) return
  desk.applyFields({ ...desk.fields.value, title: (e.target as HTMLInputElement).value }, 'field')
}

/** The frame's first photo with its current title and caption (from the preview state). */
function firstPhoto(f: DeskFrame, i: number): { id: string; title: string; caption: string } | null {
  const p = f.photos[0]
  if (!p) return null
  const view = desk.previewCollection.value?.frames[i]?.photos.find((v) => v.id === p.id)
  return { id: p.id, title: view?.title ?? p.title, caption: view?.caption ?? '' }
}

function changePhotoTitle(f: DeskFrame, i: number, e: Event) {
  const p = firstPhoto(f, i)
  if (!p) return
  desk.setPhotoMeta(p.id, { title: (e.target as HTMLInputElement).value, caption: p.caption })
}

function onPublish() {
  if (locked.value) return
  if (published.value) emit('unpublish')
  else emit('publish')
}
</script>

<template>
  <div class="mobile">
    <header class="head">
      <div class="field">
        <label :for="`${uid}-title`">合集标题</label>
        <input
          :id="`${uid}-title`"
          data-collection-title
          type="text"
          :value="desk.fields.value.title"
          :disabled="locked"
          @input="changeCollectionTitle"
        />
      </div>
      <div class="status-row">
        <p class="save" role="status" data-mobile-save :data-save="desk.saveState.value">
          {{ saveLabel }}
          <span v-if="desk.errorMessage.value" class="save-error">{{ desk.errorMessage.value }}</span>
        </p>
        <button v-if="desk.saveState.value === 'error'" type="button" @click="desk.retry()">重试</button>
        <button type="button" class="publish" data-mobile-publish :disabled="locked" @click="onPublish">
          {{ published ? '撤回' : '发布' }}
        </button>
      </div>
    </header>

    <p class="note">在电脑上添加和编排照片</p>

    <ol class="frames" role="list">
      <li
        v-for="(f, i) in seq"
        :key="f.key"
        class="frame"
        role="listitem"
        data-mobile-frame
        :aria-label="frameLabel(f, i)"
      >
        <div class="top">
          <div class="thumb">
            <Cover v-if="f.photos[0]" :media="f.photos[0].media" sizes="96px" :eager="i < 4" :high="false" alt="" :aspect="1" :tiers="['w480']" />
            <p v-else class="text-thumb">{{ textPreview(f) }}</p>
          </div>
          <p class="num">第 {{ i + 1 }} 帧</p>
        </div>

        <div class="field">
          <label :for="`${uid}-layout-${f.key}`">版式</label>
          <select
            :id="`${uid}-layout-${f.key}`"
            :value="f.layout"
            :disabled="locked || allowedLayouts(f).length < 2"
            @change="changeLayout(i, $event)"
          >
            <option v-for="l in allowedLayouts(f)" :key="l" :value="l">{{ LAYOUT_LABEL[l] }}</option>
          </select>
        </div>

        <div v-if="firstPhoto(f, i)" class="field">
          <label :for="`${uid}-photo-${f.key}`">照片标题</label>
          <input
            :id="`${uid}-photo-${f.key}`"
            data-photo-title
            type="text"
            :value="firstPhoto(f, i)!.title"
            @input="changePhotoTitle(f, i, $event)"
          />
        </div>

        <div class="actions">
          <button type="button" :aria-label="`上移第 ${i + 1} 帧`" :disabled="locked || i === 0" @click="moveFrame(i, -1)">上移</button>
          <button type="button" :aria-label="`下移第 ${i + 1} 帧`" :disabled="locked || i === seq.length - 1" @click="moveFrame(i, 1)">
            下移
          </button>
          <button type="button" :aria-label="`删除第 ${i + 1} 帧`" :disabled="locked" @click="removeFrame(i)">删除</button>
        </div>
      </li>
    </ol>

    <div class="sr-only" aria-live="polite" aria-atomic="true" data-desk-live>{{ announcement }}</div>
  </div>
</template>

<style scoped>
.mobile {
  display: flex;
  flex-direction: column;
  gap: var(--space-16);
}
.head {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  padding: var(--space-12) 0;
  border-bottom: 1px solid var(--line);
  background: var(--bg-wall);
}
.status-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-8);
}
.save {
  flex: 1 1 auto;
  margin: 0;
  color: var(--fg-muted);
}
.save-error {
  margin-left: var(--space-8);
  color: var(--fg);
}
.note {
  margin: 0;
  color: var(--fg-muted);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-4, 4px);
}
label {
  color: var(--fg-muted);
  font-size: 0.875rem;
}
input,
select {
  min-height: 44px;
  padding: 0 var(--space-12);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
}
.frames {
  display: flex;
  flex-direction: column;
  gap: var(--space-16);
  margin: 0;
  padding: 0;
  list-style: none;
}
.frame {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
  padding-bottom: var(--space-16);
  border-bottom: 1px solid var(--line);
}
.top {
  display: flex;
  align-items: center;
  gap: var(--space-12);
}
.thumb {
  width: 72px;
  flex: none;
}
.text-thumb {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  font-size: 0.75rem;
  white-space: pre-line;
  color: var(--fg-muted);
}
.num {
  margin: 0;
}
.actions {
  display: flex;
  gap: var(--space-8);
}
.actions button {
  flex: 1 1 0;
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
button:disabled,
select:disabled,
input:disabled {
  cursor: default;
  opacity: 0.6;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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
