<script setup lang="ts">
// Left edge (spec §5.2): the position scale. Up to 40 frames get one tick
// button each; longer collections get a proportional slider.
import { computed } from 'vue'

const props = defineProps<{
  current: number
  /** Content frames, end frame excluded. */
  frames: number
  atEnd: boolean
}>()

const emit = defineEmits<{ go: [n: number] }>()

const MAX_TICKS = 40
/** Above this many ticks each one is too short to be a 44px target: one hit column maps y to a frame. */
const HIT_COLUMN_OVER = 12

const ticks = computed(() => Array.from({ length: props.frames }, (_, i) => i + 1))
const shown = computed(() => Math.min(props.current, props.frames))
const width = computed(() => Math.max(2, String(props.frames).length))
const pad = (n: number) => String(n).padStart(width.value, '0')
const ratio = computed(() => (props.frames <= 1 ? 1 : (shown.value - 1) / (props.frames - 1)))

function clampGo(n: number) {
  const v = Math.min(props.frames, Math.max(1, n))
  if (v !== props.current) emit('go', v)
}

function onSliderKey(e: KeyboardEvent) {
  const step: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, PageDown: 10, PageUp: -10 }
  let target: number | null = null
  if (e.key in step) target = shown.value + step[e.key]!
  else if (e.key === 'Home') target = 1
  else if (e.key === 'End') target = props.frames
  if (target === null) return
  // Handled here; the viewer skips prevented keys.
  e.preventDefault()
  clampGo(target)
}

/** Click on the tick hit column: map y onto the tick under it. */
function onColumnClick(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  if (r.height <= 0) return
  const t = Math.min(0.9999, Math.max(0, (e.clientY - r.top) / r.height))
  clampGo(1 + Math.floor(t * props.frames))
}

function onSliderClick(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  if (r.height <= 0) return
  const t = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
  clampGo(1 + Math.round(t * (props.frames - 1)))
}
</script>

<template>
  <nav class="left" aria-label="帧位置">
    <p class="count">
      <template v-if="atEnd">结尾</template>
      <template v-else>{{ pad(shown) }}</template>
      <span class="total"> / {{ pad(frames) }}</span>
    </p>
    <div v-if="frames <= MAX_TICKS" class="ticks" :class="{ dense: frames > HIT_COLUMN_OVER }">
      <button
        v-for="n in ticks"
        :key="n"
        type="button"
        class="tick"
        :aria-label="`跳到第 ${n} 帧`"
        :aria-current="n === current ? 'true' : undefined"
        @click="clampGo(n)"
      />
      <!-- Pointer target only; the ticks under it stay the keyboard targets. -->
      <div v-if="frames > HIT_COLUMN_OVER" class="hit" data-edge-hit aria-hidden="true" @click="onColumnClick" />
    </div>
    <div
      v-else
      class="bar"
      role="slider"
      tabindex="0"
      aria-label="帧位置"
      aria-orientation="vertical"
      aria-valuemin="1"
      :aria-valuemax="frames"
      :aria-valuenow="shown"
      :aria-valuetext="`第 ${shown} 帧，共 ${frames} 帧`"
      @keydown="onSliderKey"
      @click="onSliderClick"
    >
      <span class="thumb" :style="{ top: `${ratio * 100}%` }" />
    </div>
  </nav>
</template>

<style scoped>
.left {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  gap: var(--space-12);
  padding-left: max(var(--space-8), env(safe-area-inset-left));
}

.count {
  margin: 0;
  padding-left: var(--space-8);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--fg);
}

.total {
  color: var(--fg-muted);
}

.ticks {
  position: relative;
  display: flex;
  flex-direction: column;
  max-height: calc(100% - 96px);
  overflow: hidden;
}

/* Each tick is a 44×44 target (spec §6.2); the visible mark stays a short line. */
.tick {
  display: flex;
  align-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  padding: 0 var(--space-8);
  border: 0;
  background: transparent;
  cursor: pointer;
}

/* Dense scales keep the 12px rhythm; the hit column takes the pointer. */
.dense {
  max-height: 60vh;
}

.dense .tick {
  height: 12px;
  min-height: 6px;
  flex: 0 1 12px;
}

.hit {
  position: absolute;
  inset: 0;
  cursor: pointer;
}

.tick::before {
  content: '';
  display: block;
  width: 8px;
  height: 1px;
  background: var(--fg-muted);
  transition: width var(--dur-fade);
}

.tick[aria-current='true']::before {
  width: 14px;
  background: var(--fg);
}

.tick:hover::before,
.tick:focus-visible::before {
  width: 14px;
}

.bar {
  position: relative;
  width: 44px;
  height: 50vh;
  margin-left: 0;
  cursor: pointer;
}

.bar::before {
  content: '';
  position: absolute;
  left: 12px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--line);
}

.thumb {
  position: absolute;
  left: 8px;
  width: 10px;
  height: 2px;
  margin-top: -1px;
  background: var(--fg);
}
</style>
