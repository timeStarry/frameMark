<script setup lang="ts">
// Info layer (spec §5.3): a 360px side panel at ≥1024px, otherwise a bottom
// drawer (max 60vh, swipe down to close). Non-modal dialog; focus moves in on
// open and back to the opener on close. Location is never rendered: the API
// does not send it and only whitelisted fields are read here.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Collection, Frame } from '../api/types'
import { originalURL } from '../api/client'
import { exifTable } from './format'
import Histogram from './Histogram.vue'

const props = withDefaults(defineProps<{
  open: boolean
  collection: Collection
  frame: Frame | null
  current: number
  frames: number
  /**
   * Swipe-up pull from the viewer's bottom edge, in px (≤ 0). While negative
   * and closed, the drawer is shown rising with the finger (spec §5.3).
   */
  pull?: number
  /**
   * False once the owning viewer is deactivated (a leaving instance): closing
   * then does not hand focus back to the opener inside it (N2).
   */
  active?: boolean
}>(), { active: true })

const emit = defineEmits<{ close: [] }>()

const wide = ref(typeof window !== 'undefined' && window.innerWidth >= 1024)
const onResize = () => {
  wide.value = window.innerWidth >= 1024
}

const index = ref(0)
watch(
  () => props.frame,
  () => {
    index.value = 0
  },
)

const photos = computed(() => (props.frame && props.frame.layout !== 'text' ? props.frame.photos : []))
const photo = computed(() => photos.value[Math.min(index.value, photos.value.length - 1)] ?? null)
const rows = computed(() => exifTable(photo.value?.exif ?? null))
const position = computed(() => Math.min(props.current, props.frames))

const dialog = ref<HTMLElement | null>(null)
let opener: HTMLElement | null = null
const titleId = `info-title-${Math.random().toString(36).slice(2, 8)}`

watch(
  () => props.open,
  async (open, was) => {
    if (open && !was) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      await nextTick()
      dialog.value?.focus()
    } else if (!open && was) {
      const back = opener
      opener = null
      await nextTick()
      if (props.active && back && back.isConnected) back.focus()
    }
  },
)

const dragOffset = ref(0)
const pulling = computed(() => !props.open && !wide.value && (props.pull ?? 0) < 0)
const shown = computed(() => props.open || pulling.value)
const drawerStyle = computed(() => {
  if (wide.value) return undefined
  let transform: string | undefined
  if (pulling.value) transform = `translateY(max(0px, calc(100% + ${props.pull}px)))`
  else if (dragOffset.value) transform = `translateY(${dragOffset.value}px)`
  return { maxHeight: '60vh', transform }
})

// Drawer: drag down on the handle or header to close; it follows the finger
// both ways and closes when released past 30% of its height. Presses on the close
// button (or any control) never start a drag, and capture is taken only once
// the pointer has moved: a capturing parent retargets the child's click.
const CAPTURE_PX = 4
let dragStart: number | null = null
let captured = false
function onDragStart(e: PointerEvent) {
  if (wide.value) return
  if (e.target instanceof Element && e.target.closest('button, a')) return
  dragStart = e.clientY
  captured = false
}
function onDragMove(e: PointerEvent) {
  if (dragStart === null) return
  const dy = e.clientY - dragStart
  if (!captured && Math.abs(dy) > CAPTURE_PX) {
    captured = true
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  dragOffset.value = Math.max(0, dy)
}
const CLOSE_RATIO = 0.3
function onDragEnd() {
  if (dragStart === null) return
  const h = dialog.value?.offsetHeight ?? 0
  const close = dragOffset.value > (h > 0 ? h * CLOSE_RATIO : 80)
  dragStart = null
  captured = false
  dragOffset.value = 0
  if (close) emit('close')
}

// Vertical paging keys inside the panel scroll its body (M8). Preventing them
// stops the viewer from paging: input.ts skips handled keys. ← → i Esc still
// reach the viewer; Space/Enter on a control stay with the control.
const body = ref<HTMLElement | null>(null)
const LINE_PX = 40
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
  const el = body.value
  if (!el) return
  const space = e.key === ' ' || e.key === 'Spacebar'
  if (space && e.target instanceof Element && e.target.closest('button, a[href]')) return
  const page = el.clientHeight * 0.9
  const max = Math.max(0, el.scrollHeight - el.clientHeight)
  const delta: Record<string, number> = {
    ArrowDown: LINE_PX,
    ArrowUp: -LINE_PX,
    PageDown: page,
    PageUp: -page,
  }
  let next: number
  if (e.key in delta) next = el.scrollTop + delta[e.key]!
  else if (space) next = el.scrollTop + (e.shiftKey ? -page : page)
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = max
  else return
  e.preventDefault()
  el.scrollTop = Math.min(max, Math.max(0, next))
}

onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))
</script>

<template>
  <section
    v-if="shown"
    ref="dialog"
    class="info"
    :class="[wide ? 'panel' : 'drawer', { following: pulling || dragOffset > 0 }]"
    role="dialog"
    aria-modal="false"
    :aria-labelledby="titleId"
    tabindex="-1"
    :style="drawerStyle"
    data-no-gesture
    @keydown="onKey"
  >
    <header
      class="head"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <span v-if="!wide" class="handle" aria-hidden="true" />
      <h2 :id="titleId" class="h">{{ photo?.title || collection.title }}</h2>
      <button type="button" class="close" aria-label="关闭" @click="emit('close')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </header>

    <div ref="body" class="body">
      <p v-if="photo?.caption" class="caption">{{ photo.caption }}</p>
      <p class="meta">
        <a :href="`/u/${encodeURIComponent(collection.owner.id)}`">{{ collection.owner.name }}</a>
        <span aria-hidden="true"> · </span>{{ collection.title }}
        <span aria-hidden="true"> · </span><span class="num">{{ position }} / {{ frames }}</span>
      </p>

      <div v-if="photos.length > 1" class="switch" role="group" aria-label="切换照片">
        <button type="button" aria-label="前一张" :disabled="index === 0" @click="index--">‹</button>
        <span class="num">{{ index + 1 }} / {{ photos.length }}</span>
        <button type="button" aria-label="后一张" :disabled="index >= photos.length - 1" @click="index++">›</button>
      </div>

      <template v-if="photo">
        <Histogram :histogram="photo.histogram" class="block" />
        <dl v-if="rows.length" class="table block">
          <template v-for="r in rows" :key="r.label">
            <dt>{{ r.label }}</dt>
            <dd>{{ r.value }}</dd>
          </template>
        </dl>
      </template>

      <dl v-if="collection.license || collection.aiDeclaration" class="table block">
        <template v-if="collection.license">
          <dt>许可</dt>
          <dd>{{ collection.license }}</dd>
        </template>
        <template v-if="collection.aiDeclaration">
          <dt>AI 声明</dt>
          <dd>{{ collection.aiDeclaration }}</dd>
        </template>
      </dl>

      <a v-if="photo?.downloadable" class="download block" :href="originalURL(photo.id, collection.id)" download>下载原图</a>
    </div>
  </section>
</template>

<style scoped>
.info {
  display: flex;
  flex-direction: column;
  background: #0d0d0d;
  color: var(--fg);
  outline: none;
  overflow: hidden;
}

.panel {
  width: 360px;
  height: 100%;
  border-left: 1px solid var(--line);
}

.drawer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  border-top: 1px solid var(--line);
  border-radius: 12px 12px 0 0;
  padding-bottom: env(safe-area-inset-bottom);
  transition: transform var(--dur-fade);
}

/* Follows the finger without lag; the release animates. */
.drawer.following {
  transition: none;
}

.head {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-16) var(--space-16) var(--space-8);
  touch-action: none;
}

.handle {
  position: absolute;
  top: 6px;
  left: 50%;
  width: 36px;
  height: 4px;
  margin-left: -18px;
  border-radius: 2px;
  background: var(--line);
}

.h {
  flex: 1 1 auto;
  margin: 0;
  font-family: var(--font-title);
  font-size: 18px;
  font-weight: 500;
}

.close {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin: -2px -10px -2px 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}

.close svg {
  width: 18px;
  height: 18px;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}

.body {
  overflow-y: auto;
  padding: 0 var(--space-16) var(--space-24);
  overscroll-behavior: contain;
}

.caption {
  margin: 0 0 var(--space-12);
  line-height: 1.6;
}

.meta {
  margin: 0;
  color: var(--fg-muted);
  font-size: 13px;
}

.meta a {
  color: inherit;
}

.num,
.table dd {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.block {
  margin-top: var(--space-24);
}

.switch {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  margin-top: var(--space-16);
  font-size: 13px;
}

/* 44×44 targets (spec §6.2) around the 32px ring. */
.switch button {
  position: relative;
  width: 44px;
  height: 44px;
  margin: -6px;
  border: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}

.switch button::before {
  content: '';
  position: absolute;
  inset: 6px;
  border: 1px solid var(--line);
  border-radius: 50%;
}

.switch button:disabled {
  opacity: 0.35;
  cursor: default;
}

.table {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-8) var(--space-16);
  margin-bottom: 0;
  font-size: 13px;
}

.table dt {
  color: var(--fg-muted);
}

.table dd {
  margin: 0;
}

.download {
  display: inline-block;
  padding: var(--space-8) var(--space-16);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--fg);
  font-size: 13px;
  text-decoration: none;
}
</style>
