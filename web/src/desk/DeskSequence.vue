<script setup lang="ts">
// The desk's sequence column (spec §4.3, §5). A role="list" of focusable
// frames, top to bottom in viewing order. Every drag has a keyboard twin:
//   ↑/↓        focus the previous / next frame
//   ⌥↑ / ⌥↓    move the focused frame
//   Delete / ⌫ remove it (undo via the toast or ⌘Z)
//   ⌥M         merge the next frame into it (合成并排, the drop-on-frame twin)
//   Enter      select it (opens the property slot)
// Drop targets: the gaps between frames insert (archive photos) or move (a
// frame); a frame itself merges a single photo into a pair (合成并排). Each
// gap also has a 「＋」 menu: 文字页, 从归档添加.
// The column never mutates the sequence: it computes the next Seq with the
// pure ops in sequence.ts and emits it with an announcement. While `locked`
// (an exposure check in flight or its dialog open) every edit is refused:
// buttons are disabled, frames are not draggable and drops are not accepted.
import { nextTick, ref, useId } from 'vue'
import { FRAME_TYPE, PHOTO_TYPE, hasType, readFrame, readPhotos, writeFrame } from './dnd'
import { frameLabel } from './labels'
import DeskFrame from './DeskFrame.vue'
import { insertPhotos, insertText, merge, move, remove, type DeskFrame as Frame, type DeskPhoto, type Seq } from './sequence'

const props = defineProps<{ seq: Seq; selected: number; locked?: boolean }>()
const emit = defineEmits<{
  /** A structural edit. `removed` marks a delete, which shows the undo toast. */
  edit: [next: Seq, message: string, removed?: boolean]
  /** A rejected edit (e.g. the 200-frame limit). */
  refuse: [message: string]
  focus: [index: number]
  select: [index: number]
  fromArchive: []
}>()

const uid = useId()
const list = ref<HTMLElement | null>(null)

// --- Focus ---

function itemEl(key: string): HTMLElement | null {
  return list.value?.querySelector<HTMLElement>(`[data-frame-key="${CSS.escape(key)}"]`) ?? null
}

async function focusKey(key: string | undefined) {
  if (!key) return
  await nextTick()
  itemEl(key)?.focus()
}

/** Focus a frame by index (e.g. when the property slot closes). */
function focusIndex(i: number) {
  void focusKey(props.seq[i]?.key)
}

defineExpose({ focusIndex })

// --- Edits ---

function apply(next: Seq, message: string, refusal: string, removed = false): boolean {
  if (props.locked) return false
  if (next === props.seq) {
    emit('refuse', refusal)
    return false
  }
  emit('edit', next, message, removed)
  return true
}

function moveFrame(from: number, to: number) {
  const f = props.seq[from]
  if (!f || to < 0 || to >= props.seq.length) return
  if (apply(move(props.seq, from, to), `已移到第 ${to + 1} 帧`, '无法移动')) void focusKey(f.key)
}

function removeFrame(i: number) {
  const s = props.seq
  if (!s[i]) return
  const neighbour = s[i + 1] ?? s[i - 1]
  if (apply(remove(s, i), `已删除第 ${i + 1} 帧`, '无法删除', true)) {
    if (neighbour) void focusKey(neighbour.key)
    else list.value?.focus()
  }
}

function addPhotosAt(at: number, photos: DeskPhoto[]) {
  if (photos.length === 0) return
  const next = insertPhotos(props.seq, at, photos)
  const msg = photos.length === 1 ? `已加入到第 ${at + 1} 帧` : `已加入 ${photos.length} 帧，从第 ${at + 1} 帧起`
  apply(next, msg, '合集最多 200 帧')
}

function addText(at: number) {
  menuAt.value = null
  const next = insertText(props.seq, at)
  if (apply(next, `已插入文字页，第 ${at + 1} 帧`, '合集最多 200 帧')) void focusKey(next[at]?.key)
}

/** An archive photo dropped on frame `into`: insert it after, then merge. */
function mergePhoto(photo: DeskPhoto, into: number): Seq {
  const withPhoto = insertPhotos(props.seq, into + 1, [photo])
  if (withPhoto === props.seq) return props.seq
  const merged = merge(withPhoto, into + 1, into)
  return merged === withPhoto ? props.seq : merged
}

const isSingle = (f: Frame) => (f.layout === 'full' || f.layout === 'matted') && f.photos.length === 1
const canTakePhoto = (f: Frame, id: string | null) =>
  (isSingle(f) || (f.layout === 'pair' && f.photos.length === 2)) && (id === null || !f.photos.some((p) => p.id === id))

// --- Keyboard ---

/** Why ⌥M cannot merge frame i+1 into frame i, or '' when it can. Same rule as the drop target. */
function mergeRefusal(i: number): string {
  const target = props.seq[i]
  const next = props.seq[i + 1]
  if (!target || !canTakePhoto(target, null)) return '这一帧不能合成并排'
  if (!next) return '后面没有可合成的帧'
  if (!isSingle(next)) return '下一帧不是单张照片，不能合成并排'
  if (!canTakePhoto(target, next.photos[0]?.id ?? null)) return '两帧是同一张照片，不能合成并排'
  return ''
}

function mergeNext(i: number) {
  if (props.locked) return
  const reason = mergeRefusal(i)
  if (reason) {
    emit('refuse', reason)
    return
  }
  const target = props.seq[i]!
  if (apply(merge(props.seq, i + 1, i), `已合成并排：第 ${i + 1} 帧`, '这一帧不能合成并排')) void focusKey(target.key)
}

/** ⌥M: macOS reports the key as 'µ', so the physical code counts too. */
const isAltM = (e: KeyboardEvent) => e.altKey && !e.shiftKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')

function onItemKey(i: number, e: KeyboardEvent) {
  if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey) return
  const k = e.key
  if (isAltM(e)) {
    e.preventDefault()
    mergeNext(i)
    return
  }
  if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
    e.preventDefault()
    moveFrame(i, k === 'ArrowUp' ? i - 1 : i + 1)
    return
  }
  if (e.altKey || e.shiftKey) return
  switch (k) {
    case 'ArrowUp':
    case 'ArrowDown': {
      e.preventDefault()
      void focusKey(props.seq[k === 'ArrowUp' ? i - 1 : i + 1]?.key)
      return
    }
    case 'Delete':
    case 'Backspace':
      e.preventDefault()
      removeFrame(i)
      return
    case 'Enter':
      e.preventDefault()
      emit('select', i)
      return
  }
}

// --- 「＋」 menu ---

const menuAt = ref<number | null>(null)

async function toggleMenu(at: number) {
  if (props.locked) return
  menuAt.value = menuAt.value === at ? null : at
  if (menuAt.value === null) return
  await nextTick()
  list.value?.parentElement?.querySelector<HTMLElement>(`[data-gap="${at}"] .menu button`)?.focus()
}

function onMenuKey(at: number, e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  menuAt.value = null
  void nextTick(() => list.value?.parentElement?.querySelector<HTMLElement>(`[data-gap="${at}"] .plus`)?.focus())
}

function fromArchive() {
  menuAt.value = null
  emit('fromArchive')
}

// --- Drag and drop ---

const dragKey = ref<string | null>(null)
const dropGap = ref<number | null>(null)
const dropFrame = ref<number | null>(null)

function onDragStart(f: Frame, e: DragEvent) {
  if (props.locked) {
    e.preventDefault()
    return
  }
  // A drag may start on a thumbnail inside the card: it still moves the frame.
  // Drop the image URL the browser pre-filled, so only the frame travels.
  if (!e.dataTransfer) return
  e.dataTransfer.clearData()
  writeFrame(e.dataTransfer, f.key)
  dragKey.value = f.key
}

function onDragEnd() {
  dragKey.value = null
  dropGap.value = null
  dropFrame.value = null
}

const accepts = (e: DragEvent) => !props.locked && (hasType(e, PHOTO_TYPE) || hasType(e, FRAME_TYPE))

function onGapOver(at: number, e: DragEvent) {
  if (!accepts(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = hasType(e, FRAME_TYPE) ? 'move' : 'copy'
  dropGap.value = at
  dropFrame.value = null
}

function onGapDrop(at: number, e: DragEvent) {
  if (!accepts(e)) return
  e.preventDefault()
  onDragEnd()
  const key = readFrame(e.dataTransfer)
  if (key) {
    const from = props.seq.findIndex((f) => f.key === key)
    if (from < 0) return
    // Gap `at` sits before frame `at`; removing `from` first shifts later gaps up.
    const to = from < at ? at - 1 : at
    if (to !== from) moveFrame(from, to)
    return
  }
  addPhotosAt(at, readPhotos(e.dataTransfer))
}

/** The frame being dragged, when the drag is a frame move. */
function draggedFrame(): Frame | null {
  return dragKey.value ? (props.seq.find((f) => f.key === dragKey.value) ?? null) : null
}

function onFrameOver(i: number, e: DragEvent) {
  const target = props.seq[i]
  if (!target || props.locked) return
  if (hasType(e, FRAME_TYPE)) {
    const src = draggedFrame()
    // A frame's own key can only be read on drop; during dragover we rely on
    // the drag that started here. A drag from elsewhere is left to the drop.
    if (src && (src.key === target.key || !isSingle(src) || !canTakePhoto(target, src.photos[0]?.id ?? null))) return
  } else if (hasType(e, PHOTO_TYPE)) {
    if (!canTakePhoto(target, null)) return
  } else return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = hasType(e, FRAME_TYPE) ? 'move' : 'copy'
  dropFrame.value = i
  dropGap.value = null
}

function onFrameDrop(i: number, e: DragEvent) {
  if (!accepts(e)) return
  e.preventDefault()
  onDragEnd()
  const target = props.seq[i]
  if (!target) return
  const key = readFrame(e.dataTransfer)
  if (key) {
    const from = props.seq.findIndex((f) => f.key === key)
    if (from < 0 || from === i) return
    const next = merge(props.seq, from, i)
    const at = from < i ? i - 1 : i
    if (apply(next, `已合成并排：第 ${at + 1} 帧`, '这两帧不能合成并排')) void focusKey(target.key)
    return
  }
  const photos = readPhotos(e.dataTransfer)
  const photo = photos[0]
  if (photos.length !== 1 || !photo) {
    emit('refuse', '一次只能把一张照片合成并排')
    return
  }
  if (apply(mergePhoto(photo, i), `已合成并排：第 ${i + 1} 帧`, '这一帧不能再合成并排')) void focusKey(target.key)
}

function onLeave(e: DragEvent) {
  const to = e.relatedTarget as Node | null
  if (to && (e.currentTarget as HTMLElement).contains(to)) return
  dropGap.value = null
  dropFrame.value = null
}
</script>

<template>
  <section class="desk-sequence" :aria-labelledby="`${uid}-h`">
    <h2 :id="`${uid}-h`">序列</h2>
    <div
      v-if="seq.length === 0"
      class="empty"
      :class="{ over: dropGap === 0 }"
      data-gap="0"
      @dragover="onGapOver(0, $event)"
      @dragleave="onLeave"
      @drop="onGapDrop(0, $event)"
    >
      <p>从左侧归档拖入照片，或按 Enter 加入</p>
      <button type="button" class="text-add" :disabled="locked" @click="addText(0)">加入文字页</button>
    </div>
    <ol
      ref="list"
      role="list"
      class="frames"
      :aria-labelledby="`${uid}-h`"
      tabindex="-1"
      @dragend="onDragEnd"
    >
      <template v-for="(f, i) in seq" :key="f.key">
        <li
          class="gap"
          role="presentation"
          :class="{ over: dropGap === i }"
          :data-gap="i"
          @dragover="onGapOver(i, $event)"
          @dragleave="onLeave"
          @drop="onGapDrop(i, $event)"
        >
          <button
            type="button"
            class="plus"
            :disabled="locked"
            :aria-label="`在第 ${i + 1} 帧前插入`"
            :aria-expanded="menuAt === i ? 'true' : 'false'"
            @click="toggleMenu(i)"
          >
            ＋
          </button>
          <div v-if="menuAt === i && !locked" class="menu" @keydown="onMenuKey(i, $event)">
            <button type="button" @click="addText(i)">文字页</button>
            <button type="button" @click="fromArchive">从归档添加</button>
          </div>
        </li>
        <li
          role="listitem"
          tabindex="0"
          :draggable="locked ? 'false' : 'true'"
          class="item"
          :class="{ current: i === selected, dragging: dragKey === f.key, merge: dropFrame === i }"
          :data-frame-key="f.key"
          :aria-label="frameLabel(f, i)"
          @focus="emit('focus', i)"
          @click="emit('select', i)"
          @keydown="onItemKey(i, $event)"
          @dragstart="onDragStart(f, $event)"
          @dragover="onFrameOver(i, $event)"
          @dragleave="onLeave"
          @drop="onFrameDrop(i, $event)"
        >
          <DeskFrame :frame="f" :index="i" />
          <span v-if="dropFrame === i" class="hint" aria-hidden="true">合成并排</span>
        </li>
      </template>
      <li
        v-if="seq.length > 0"
        class="gap last"
        role="presentation"
        :class="{ over: dropGap === seq.length }"
        :data-gap="seq.length"
        @dragover="onGapOver(seq.length, $event)"
        @dragleave="onLeave"
        @drop="onGapDrop(seq.length, $event)"
      >
        <button
          type="button"
          class="plus"
          :disabled="locked"
          aria-label="在末尾插入"
          :aria-expanded="menuAt === seq.length ? 'true' : 'false'"
          @click="toggleMenu(seq.length)"
        >
          ＋
        </button>
        <div v-if="menuAt === seq.length && !locked" class="menu" @keydown="onMenuKey(seq.length, $event)">
          <button type="button" @click="addText(seq.length)">文字页</button>
          <button type="button" @click="fromArchive">从归档添加</button>
        </div>
      </li>
    </ol>
    <p class="legend">Enter 加入或选中 · 空格 多选 · ⌥↑ ⌥↓ 移动 · ⌥M 与下一帧合成并排 · Delete 删除 · ⌘Z 撤销 · ⇧⌘Z 重做</p>
  </section>
</template>

<style scoped>
.desk-sequence {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  min-width: 0;
}
h2 {
  margin: 0;
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 1.125rem;
}
.frames {
  margin: 0;
  padding: 0;
  list-style: none;
}
.frames:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.item {
  position: relative;
  border: 1px solid var(--line);
  background: var(--bg-wall);
  cursor: grab;
  outline: none;
}
.item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.item.current {
  border-color: var(--fg-muted);
}
.item.dragging {
  opacity: 0.5;
}
.item.merge {
  border-color: var(--accent);
  border-style: dashed;
}
.hint {
  position: absolute;
  right: var(--space-8);
  top: var(--space-8);
  padding: 0 var(--space-8);
  background: var(--accent);
  color: var(--bg-wall);
  font-size: 0.85em;
  line-height: 22px;
}
.gap {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 44px;
  justify-content: center;
}
.gap.over::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 2px;
  background: var(--accent);
}
button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-12);
  border: 1px solid var(--line);
  border-radius: 0;
  background: var(--bg-wall);
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.plus {
  position: relative;
  border-color: transparent;
  color: var(--fg-muted);
}
.plus:hover,
.plus[aria-expanded='true'] {
  border-color: var(--line);
  color: var(--fg);
}
.menu {
  display: flex;
  gap: var(--space-8);
  padding: var(--space-8) 0;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-12);
  padding: var(--space-48) var(--space-16);
  border: 1px dashed var(--line);
  color: var(--fg-muted);
  text-align: center;
}
.empty p {
  margin: 0;
}
.empty.over {
  border-color: var(--accent);
}
.legend {
  margin: var(--space-8) 0 0;
  color: var(--fg-muted);
  font-size: 0.85em;
}
</style>
