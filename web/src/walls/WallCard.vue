<script setup lang="ts">
// One wall card (spec §5): cover, mouse sweep through previews, touch dots,
// and a single caption line. The whole card is a real link.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Card } from '../api/types'
import Cover from './Cover.vue'
import { sweepIndex } from './layout'

const props = defineProps<{
  card: Card
  wall: string
  showOwner: boolean
  eager: boolean
  high: boolean
  aspect: number | null
  sizes?: string
}>()

const router = useRouter()

// Read once: hover-capable devices sweep, others get the count dots.
const hover = typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches

const path = computed(() => `/c/${encodeURIComponent(props.card.id)}`)
const href = computed(() => router.resolve({ path: path.value, query: { wall: props.wall } }).href)
const label = computed(() =>
  [props.card.title, props.showOwner ? props.card.owner.name : null, `${props.card.count} 张`]
    .filter((s): s is string => !!s)
    .join('，'),
)
const dots = computed(() => Math.min(props.card.count, 5))
const sizes = computed(() => props.sizes ?? '(max-width: 599px) 100vw, (max-width: 1099px) 50vw, 33vw')

// Previews are only mounted (and so only fetched) after the first mouse entry.
const entered = ref(false)
const shown = ref(-1) // -1 = cover
const media = computed(() => (shown.value >= 0 ? (props.card.previews[shown.value] ?? props.card.cover) : props.card.cover))

function sweeps(e: PointerEvent): boolean {
  return hover && e.pointerType === 'mouse' && props.card.previews.length > 0
}
function onEnter(e: PointerEvent) {
  if (sweeps(e)) entered.value = true
}
function onMove(e: PointerEvent) {
  if (!sweeps(e)) return
  entered.value = true
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  shown.value = sweepIndex(e.clientX - r.left, r.width, props.card.previews.length)
}
function onLeave() {
  shown.value = -1
}

function onClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  void router.push({
    path: path.value,
    query: { wall: props.wall },
    state: { fromWall: true, viewerDepth: 0 },
  })
}
</script>

<template>
  <a class="card" :href="href" :data-card-id="card.id" :aria-label="label" @click="onClick">
    <div class="frame" @pointerenter="onEnter" @pointermove="onMove" @pointerleave="onLeave">
      <Cover :media="media" :sizes="sizes" :eager="eager" :high="high" alt="" :aspect="aspect" />
      <span v-if="!hover && dots > 0" class="dots" aria-hidden="true"><i v-for="n in dots" :key="n" /></span>
      <span v-if="entered" class="preload" aria-hidden="true">
        <Cover
          v-for="(p, i) in card.previews"
          :key="i"
          :media="p"
          sizes="(max-width: 1099px) 480px, 1280px"
          :eager="true"
          :high="false"
          alt=""
        />
      </span>
    </div>
    <p class="line">
      <span class="title">{{ card.title }}</span>
      <span class="meta"><template v-if="showOwner"> · {{ card.owner.name }}</template> · {{ card.count }} 张</span>
    </p>
  </a>
</template>

<style scoped>
.card {
  display: block;
  color: var(--fg);
  text-decoration: none;
  min-height: 44px;
}
.card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
.frame {
  position: relative;
}
.dots {
  position: absolute;
  right: var(--space-8);
  bottom: var(--space-8);
  display: flex;
  gap: var(--space-4);
}
.dots i {
  display: block;
  width: 2px;
  height: 2px;
  background: var(--fg);
}
.preload {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}
.line {
  margin: 0;
  padding-top: var(--space-8);
  line-height: 24px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.title {
  color: var(--fg);
}
.meta {
  color: var(--fg-muted);
}
</style>
