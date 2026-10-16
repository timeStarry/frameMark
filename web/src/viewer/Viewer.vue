<script setup lang="ts">
// Collection viewer: stage, frame track, windowing, preload and the a11y live
// region (spec §5.1, §6.1, §6.2, §8). Edges, info layer and end-frame content
// are slots filled by Task 6.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import type { Collection, Frame, Neighbors } from '../api/types'
import type { Axis, Dir, ViewerIntent } from './gesture'
import { bindInputs, type InnerScroll } from './input'
import { createPreloader, neighborEntries } from './preload'
import { useViewerState } from './useViewerState'
import FrameView from './FrameView.vue'

const props = defineProps<{
  collection: Collection
  neighbors: Neighbors | null
  /** 1-based; clamped to [1, frames.length + 1]. */
  initialFrame: number
  mode: 'public' | 'preview'
}>()

const emit = defineEmits<{
  /** Current frame changed (1-based; frames.length + 1 is the end frame). Not emitted for the initial frame. */
  frame: [n: number]
  /** Horizontal move to the adjacent collection. Never emitted in preview mode. */
  navigate: [dir: Dir]
  /** Leave the viewer. Emitted by Task 6 controls through the slot props. */
  exit: []
}>()

export interface ViewerSlotProps {
  current: number
  total: number
  /** The current collection frame, or null on the end frame. */
  frame: Frame | null
  isEnd: boolean
  go(n: number): void
  step(dir: Dir): void
  exit(): void
}

defineSlots<{
  top?(p: ViewerSlotProps): unknown
  left?(p: ViewerSlotProps): unknown
  right?(p: ViewerSlotProps): unknown
  bottom?(p: ViewerSlotProps): unknown
  info?(p: ViewerSlotProps): unknown
  end?(p: ViewerSlotProps): unknown
}>()

const STACK_QUERY = '(max-width: 599px) and (orientation: portrait)'
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'

const frames = computed(() => props.collection.frames)
const state = useViewerState({
  frameCount: computed(() => frames.value.length),
  initial: props.initialFrame,
  mode: computed(() => props.mode),
  onNavigate: (dir) => emit('navigate', dir),
})
const { current, total, go, step } = state
/** The frame first shown gets fetchpriority=high. */
const firstShown = current.value

const currentFrame = computed<Frame | null>(() => frames.value[current.value - 1] ?? null)

const slotProps = computed<ViewerSlotProps>(() => ({
  current: current.value,
  total: total.value,
  frame: currentFrame.value,
  isEnd: current.value === total.value,
  go,
  step,
  exit: () => emit('exit'),
}))

// --- media queries ---
function query(q: string): MediaQueryList | null {
  return typeof matchMedia === 'function' ? matchMedia(q) : null
}
const stackMQ = query(STACK_QUERY)
const reducedMQ = query(REDUCED_QUERY)
const stacked = ref(stackMQ?.matches ?? false)
const reducedMotion = ref(reducedMQ?.matches ?? false)
const onStack = () => {
  stacked.value = stackMQ?.matches ?? false
}

// --- track position ---
const dragX = ref(0)
const dragY = ref(0)
const dragging = ref(false)
const trackStyle = computed(() => ({
  transform: `translate3d(${dragX.value}px, calc(${-(current.value - 1) * 100}% + ${dragY.value}px), 0)`,
}))

function resetDrag() {
  dragX.value = 0
  dragY.value = 0
  dragging.value = false
}

// --- input ---
const stageEl = ref<HTMLElement | null>(null)
const frameRefs = new Map<number, InstanceType<typeof FrameView>>()
function setFrameRef(n: number, el: Element | ComponentPublicInstance | null) {
  if (el) frameRefs.set(n, el as InstanceType<typeof FrameView>)
  else frameRefs.delete(n)
}

/** The current frame's inner scroller, only while it is a stacked pair. */
function currentInner(): InnerScroll | undefined {
  if (!stacked.value || currentFrame.value?.layout !== 'pair') return undefined
  const fv = frameRefs.get(current.value)
  if (!fv) return undefined
  return { canScroll: (d) => fv.canScrollInner(d), scrollBy: (dy) => fv.scrollInner(dy) }
}

function onIntent(i: ViewerIntent) {
  resetDrag()
  switch (i.kind) {
    case 'frame':
      step(i.dir)
      break
    case 'collection':
      if (props.mode === 'public') emit('navigate', i.dir)
      break
    case 'home':
      go(1)
      break
    case 'end':
      go(total.value)
      break
  }
}

function onDrag(axis: Axis, offset: number) {
  if (axis === 'x' && props.mode === 'preview') return
  if (axis === 'x') dragX.value = offset
  else dragY.value = offset
  dragging.value = offset !== 0
}

let unbind: (() => void) | null = null
function bind() {
  unbind?.()
  const el = stageEl.value
  if (!el) return
  unbind = bindInputs(
    el,
    { intent: onIntent, drag: onDrag, tap: () => {}, doubleTap: () => {} },
    {
      reducedMotion: reducedMotion.value,
      // Read on every event: inner exists only while the current frame is a stacked pair.
      get inner() {
        return currentInner()
      },
    },
  )
}
const onReduced = () => {
  reducedMotion.value = reducedMQ?.matches ?? false
  resetDrag()
  bind()
}

// --- a11y announcement ---
const announcement = ref('')
function describe(n: number): string {
  const count = frames.value.length
  const f = frames.value[n - 1]
  if (!f) return `结尾，共 ${count} 帧。${props.collection.title}`
  const label = f.layout === 'text' ? (f.text ?? '') : (f.photos[0]?.title || f.photos[0]?.caption || '')
  return `第 ${n} 帧，共 ${count} 帧。${label}`.trim()
}

// --- preload ---
const preloader = createPreloader()
let preloadToken = 0
async function preloadAround(n: number) {
  const token = ++preloadToken
  const entries = neighborEntries(frames.value, n)
  preloader.prune(entries) // frames that left the neighbourhood drop their links now
  await nextTick()
  const imgs = [...(stageEl.value?.querySelectorAll<HTMLImageElement>(`[data-frame="${n}"] img`) ?? [])]
  // Decode failures still release the neighbours; the error notice handles the current frame.
  await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)))
  if (token !== preloadToken || unmounted) return
  preloader.set(entries)
}

watch(current, (n) => {
  emit('frame', n)
  announcement.value = describe(n)
  void preloadAround(n)
})

let unmounted = false
onMounted(() => {
  stackMQ?.addEventListener('change', onStack)
  reducedMQ?.addEventListener('change', onReduced)
  bind()
  void preloadAround(current.value)
})

onBeforeUnmount(() => {
  unmounted = true
  unbind?.()
  unbind = null
  stackMQ?.removeEventListener('change', onStack)
  reducedMQ?.removeEventListener('change', onReduced)
  preloader.clear()
})

const sequence = computed(() => Array.from({ length: total.value }, (_, i) => i + 1))
</script>

<template>
  <div class="viewer">
    <div
      ref="stageEl"
      class="stage"
      role="region"
      aria-roledescription="合集观看"
      :aria-label="collection.title"
      style="touch-action: none"
    >
      <div class="track" :class="{ dragging }" :style="trackStyle">
        <div
          v-for="n in sequence"
          :key="n"
          class="frame-slot"
          :data-frame="n"
          :style="{ top: `${(n - 1) * 100}%` }"
          :aria-hidden="n === current ? undefined : 'true'"
          :inert="n !== current"
        >
          <FrameView
            v-if="frames[n - 1]"
            :ref="(el) => setFrameRef(n, el)"
            :frame="frames[n - 1]!"
            :live="state.window.value.has(n)"
            :priority="n === firstShown"
            :stacked="stacked"
          />
          <div v-else class="end-frame">
            <slot name="end" v-bind="slotProps" />
          </div>
        </div>
      </div>

      <div class="edge edge-top"><slot name="top" v-bind="slotProps" /></div>
      <div class="edge edge-left"><slot name="left" v-bind="slotProps" /></div>
      <div class="edge edge-right"><slot name="right" v-bind="slotProps" /></div>
      <div class="edge edge-bottom"><slot name="bottom" v-bind="slotProps" /></div>
    </div>

    <div class="info-layer"><slot name="info" v-bind="slotProps" /></div>

    <div class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement }}</div>
  </div>
</template>

<style scoped>
.viewer {
  position: relative;
  display: flex;
  width: 100%;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg-view);
  color: var(--fg);
}

.stage {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}

.track {
  position: absolute;
  inset: 0;
  transition: transform var(--dur-move) var(--ease-move);
  will-change: transform;
}

.track.dragging {
  transition: none;
}

.frame-slot {
  position: absolute;
  left: 0;
  width: 100%;
  height: 100%;
  padding:
    max(var(--space-4), env(safe-area-inset-top))
    max(var(--space-4), env(safe-area-inset-right))
    max(var(--space-4), env(safe-area-inset-bottom))
    max(var(--space-4), env(safe-area-inset-left));
}

@media (min-width: 768px) {
  .frame-slot {
    padding:
      max(var(--space-24), env(safe-area-inset-top))
      max(var(--space-24), env(safe-area-inset-right))
      max(var(--space-24), env(safe-area-inset-bottom))
      max(var(--space-24), env(safe-area-inset-left));
  }
}

.end-frame {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Edge regions: positioned containers only; Task 6 owns their content and visibility. */
.edge {
  position: absolute;
  z-index: 1;
  pointer-events: none;
}

.edge > :deep(*) {
  pointer-events: auto;
}

.edge-top {
  top: 0;
  left: 0;
  right: 0;
}

.edge-bottom {
  bottom: 0;
  left: 0;
  right: 0;
}

.edge-left {
  top: 0;
  bottom: 0;
  left: 0;
}

.edge-right {
  top: 0;
  bottom: 0;
  right: 0;
}

.info-layer:empty {
  display: none;
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

@media (prefers-reduced-motion: reduce) {
  .viewer {
    --dur-move: 0ms;
    --dur-fade: 0ms;
  }
}
</style>
