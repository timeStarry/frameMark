<script setup lang="ts">
// Collection viewer: stage, frame track, windowing, preload and the a11y live
// region (spec §5.1, §6.1, §6.2, §8), plus the default edges, info layer and
// end frame (§5.2–§5.4). Each slot overrides its default content.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import type { Collection, Frame, Neighbors } from '../api/types'
import type { Axis, Dir, ViewerIntent } from './gesture'
import { bindInputs, type InnerScroll } from './input'
import { createPreloader, neighborEntries } from './preload'
import { useViewerState } from './useViewerState'
import FrameView from './FrameView.vue'
import EdgeTop from './EdgeTop.vue'
import EdgeLeft from './EdgeLeft.vue'
import EdgeRight from './EdgeRight.vue'
import EdgeBottom from './EdgeBottom.vue'
import InfoLayer from './InfoLayer.vue'
import EndFrame from './EndFrame.vue'
import { useEdges } from './useEdges'
import { useFullscreen } from './useFullscreen'

const props = withDefaults(defineProps<{
  collection: Collection
  neighbors: Neighbors | null
  /** 1-based; clamped to [1, frames.length + 1]. */
  initialFrame: number
  mode: 'public' | 'preview'
  /**
   * Owner of the collection shown before this one (horizontal navigation).
   * When it differs from this collection's owner, the top edge flashes and the
   * new author is announced (spec §5.2).
   */
  fromOwnerId?: string | null
  /**
   * False while the instance is leaving (a collection transition keeps it
   * mounted for 280ms): inputs are unbound, edges stopped, no emits.
   */
  active?: boolean
  /** Move focus to the stage on mount: after a collection switch the focused control is gone (M6). */
  focusOnMount?: boolean
}>(), { active: true, fromOwnerId: null, focusOnMount: false })

const rawEmit = defineEmits<{
  /** Current frame changed (1-based; frames.length + 1 is the end frame). Not emitted for the initial frame. */
  frame: [n: number]
  /** Horizontal move to the adjacent collection. Never emitted in preview mode. */
  navigate: [dir: Dir]
  /** Leave the viewer (back button, Esc, 回到墙). */
  exit: []
  /** A strip card was chosen. Never emitted in preview mode. */
  jump: [collectionId: string]
}>()

/** Set once deactivate() runs; every emit below goes through this gate. */
let inactive = false
const emit = ((...args: Parameters<typeof rawEmit>) => {
  if (!inactive) (rawEmit as (...a: unknown[]) => void)(...args)
}) as typeof rawEmit

export interface ViewerSlotProps {
  /** 1-based position in the sequence; `frames + 1` is the end frame. */
  current: number
  /** Content frames in the collection, end frame excluded (the `12` in `03/12`). */
  frames: number
  /** The current frame is the end frame. */
  atEnd: boolean
  /** The current collection frame, or null on the end frame. */
  frame: Frame | null
  /** Clamped to [1, frames + 1]. */
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
  frames: frames.value.length,
  atEnd: current.value === total.value,
  frame: currentFrame.value,
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

// --- edges, info layer, fullscreen ---
const rootEl = ref<HTMLElement | null>(null)
const edges = useEdges()
const fullscreen = useFullscreen(rootEl)
const infoOpen = ref(false)
/** Bottom-edge swipe-up pull of the info drawer, px (≤ 0). */
const sheetPull = ref(0)
watch(infoOpen, (open) => (open ? edges.pin('info') : edges.unpin('info')))

const currentPhoto = computed(() => {
  const f = currentFrame.value
  return f && f.layout !== 'text' ? (f.photos[0] ?? null) : null
})

function onTap(pointerType: string) {
  // Mouse users reveal edges by moving to them; a touch or pen tap toggles all four.
  if (pointerType !== 'mouse') edges.toggleAll()
}

function onDoubleTap() {
  void fullscreen.toggle()
}

/** i / f / Esc (spec §6.2). An open menu handles Esc itself, before this runs. */
function onKey(e: KeyboardEvent): boolean {
  if (e.key === 'i' || e.key === 'I') {
    infoOpen.value = !infoOpen.value
    return true
  }
  if ((e.key === 'f' || e.key === 'F') && fullscreen.supported) {
    void fullscreen.toggle()
    return true
  }
  if (e.key === 'Escape') {
    if (infoOpen.value) infoOpen.value = false
    else if (fullscreen.active.value) void fullscreen.toggle()
    else emit('exit')
    return true
  }
  return false
}

function onJump(id: string) {
  if (props.mode === 'public') emit('jump', id)
}

function onEndNavigate() {
  if (props.mode === 'public') emit('navigate', 1)
}

function announceAuthor() {
  edges.flashTop(1500)
  announcement.value = `${props.collection.owner.name} 的「${props.collection.title}」`
}

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

/** The current frame's inner scroller: a stacked pair or a text frame, else none. */
function currentInner(): InnerScroll | undefined {
  const fv = frameRefs.get(current.value)
  if (!fv || !fv.hasInner()) return undefined
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
    case 'info':
      sheetPull.value = 0
      infoOpen.value = true
      break
  }
}

function onDrag(axis: Axis, offset: number) {
  if (axis === 'x' && props.mode === 'preview') return
  if (axis === 'x') dragX.value = offset
  else dragY.value = offset
  // A zero mid-gesture (offset crossing its origin, inner absorbing the move)
  // must not re-enable the transition; only the release ends dragging.
  dragging.value = true
}

/**
 * Pointer released: end dragging once this event's dispatch is over, i.e. after
 * input.ts has sent its final drag(…, 0) or intent, whatever the listener order.
 */
function onRelease() {
  queueMicrotask(() => {
    dragging.value = false
  })
}

let unbind: (() => void) | null = null
function bind() {
  unbind?.()
  unbind = null
  if (inactive) return
  const el = stageEl.value
  if (!el) return
  unbind = bindInputs(
    el,
    {
      intent: onIntent,
      drag: onDrag,
      tap: onTap,
      doubleTap: onDoubleTap,
      key: onKey,
      sheet: (offset) => {
        // An open drawer is already up; the pull only matters while closed.
        sheetPull.value = infoOpen.value ? 0 : offset
      },
    },
    {
      reducedMotion: reducedMotion.value,
      // Read on every event: inner exists only while the current frame is a stacked pair or a text frame.
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
/** Settles the previous call's wait, so its closure (and detached imgs) can be collected. */
let abortWait: (() => void) | null = null
async function preloadAround(n: number) {
  const token = ++preloadToken
  abortWait?.()
  const aborted = new Promise<void>((resolve) => {
    abortWait = resolve
  })
  const entries = neighborEntries(frames.value, n)
  preloader.prune(entries) // frames that left the neighbourhood drop their links now
  await nextTick()
  const imgs = [...(stageEl.value?.querySelectorAll<HTMLImageElement>(`[data-frame="${n}"] img`) ?? [])]
  // Decode failures still release the neighbours; the error notice handles the current frame.
  // An img removed before it loads never settles decode(), hence the race with the abort.
  await Promise.race([Promise.all(imgs.map((img) => img.decode().catch(() => undefined))), aborted])
  if (token !== preloadToken || unmounted) return
  abortWait = null
  preloader.set(entries)
}

watch(current, (n, o) => {
  emit('frame', n)
  announcement.value = describe(n)
  void preloadAround(n)
  // Enter an inner scroller from the side we came from, so every part of it is shown.
  void nextTick(() => frameRefs.get(n)?.resetInner(n > o ? 'start' : 'end'))
})

// In-place collection swaps (Task 7 normally remounts with :key, see fromOwnerId).
watch(
  () => props.collection.owner.id,
  (id, old) => {
    if (id !== old) announceAuthor()
  },
)

/** Stop handling input right away; the instance may stay mounted for a leave transition. */
function deactivate() {
  if (inactive) return
  inactive = true
  unbind?.()
  unbind = null
  edges.stop()
  infoOpen.value = false
  sheetPull.value = 0
  resetDrag()
}

function activate() {
  if (!inactive) return
  inactive = false
  if (stageEl.value) edges.attach(stageEl.value)
  bind()
}

watch(
  () => props.active,
  (on) => (on ? activate() : deactivate()),
)

defineExpose({ deactivate })

let unmounted = false
onMounted(() => {
  if (!props.active) inactive = true
  if (stageEl.value && !inactive) edges.attach(stageEl.value)
  if (!inactive && props.focusOnMount) stageEl.value?.focus({ preventScroll: true })
  if (!inactive && props.fromOwnerId && props.fromOwnerId !== props.collection.owner.id) announceAuthor()
  stackMQ?.addEventListener('change', onStack)
  reducedMQ?.addEventListener('change', onReduced)
  bind()
  window.addEventListener('pointerup', onRelease)
  window.addEventListener('pointercancel', onRelease)
  window.addEventListener('blur', onRelease)
  void preloadAround(current.value)
})

onBeforeUnmount(() => {
  unmounted = true
  edges.stop()
  unbind?.()
  unbind = null
  abortWait?.()
  window.removeEventListener('pointerup', onRelease)
  window.removeEventListener('pointercancel', onRelease)
  window.removeEventListener('blur', onRelease)
  stackMQ?.removeEventListener('change', onStack)
  reducedMQ?.removeEventListener('change', onReduced)
  preloader.clear()
})

const sequence = computed(() => Array.from({ length: total.value }, (_, i) => i + 1))
</script>

<template>
  <div ref="rootEl" class="viewer">
    <div
      ref="stageEl"
      class="stage"
      role="region"
      aria-roledescription="合集观看"
      :aria-label="collection.title"
      tabindex="-1"
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
            <slot name="end" v-bind="slotProps">
              <EndFrame
                :collection="collection"
                :neighbors="neighbors"
                :mode="mode"
                @go="go"
                @navigate="onEndNavigate"
                @exit="emit('exit')"
              />
            </slot>
          </div>
        </div>
      </div>

      <div class="edge edge-top" data-edge="top" :class="{ shown: edges.visible.top }">
        <slot name="top" v-bind="slotProps">
          <EdgeTop
            :collection="collection"
            :photo="currentPhoto"
            :frame-index="slotProps.atEnd ? undefined : current"
            :pin="edges.pin"
            :unpin="edges.unpin"
            :fullscreen="{ supported: fullscreen.supported, active: fullscreen.active.value }"
            @exit="emit('exit')"
            @fullscreen="fullscreen.toggle()"
          />
        </slot>
      </div>
      <div class="edge edge-left" data-edge="left" :class="{ shown: edges.visible.left }">
        <slot name="left" v-bind="slotProps">
          <EdgeLeft :current="current" :frames="slotProps.frames" :at-end="slotProps.atEnd" @go="go" />
        </slot>
      </div>
      <div class="edge edge-right" data-edge="right" :class="{ shown: edges.visible.right }">
        <slot name="right" v-bind="slotProps">
          <EdgeRight :frame="currentFrame" @open="infoOpen = true" />
        </slot>
      </div>
      <div class="edge edge-bottom" data-edge="bottom" :class="{ shown: edges.visible.bottom }">
        <slot name="bottom" v-bind="slotProps">
          <EdgeBottom
            v-if="mode === 'public' && neighbors"
            :collection-id="collection.id"
            :strip="neighbors.strip"
            @jump="onJump"
          />
        </slot>
      </div>
    </div>

    <div class="info-layer">
      <slot name="info" v-bind="slotProps">
        <InfoLayer
          :open="infoOpen"
          :pull="sheetPull"
          :collection="collection"
          :frame="currentFrame"
          :current="current"
          :frames="slotProps.frames"
          @close="infoOpen = false"
        />
      </slot>
    </div>

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

/* Focus target after a collection switch only; a ring around the whole photo is noise. */
.stage:focus {
  outline: none;
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

/* Edge regions: hidden until revealed (spec §5.2). Hidden edges stay
   focusable; focusing one reveals it. */
.edge {
  position: absolute;
  z-index: 1;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--dur-fade);
}

.edge.shown {
  opacity: 1;
}

/* Only the controls take pointer events: an edge's layout box (the full-height
   right column, the full-width top bar) must not cover its neighbours or the photo. */
.edge.shown :deep(:is(button, a, [role='slider'], [role='menu'], [data-edge-hit])) {
  pointer-events: auto;
}

.stage[data-idle] {
  cursor: none;
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

.info-layer {
  flex: none;
  height: 100%;
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
