<script setup lang="ts">
// A set of cards (spec §4). Salon: one CSS grid, cards as direct children in
// input order (so DOM and Tab order match), each pinned to its column with a
// row span estimated from its height; `row dense` packs them into masonry.
// Grid: uniform auto-fill grid with 4:5 covers.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Card } from '../api/types'
import WallCard from './WallCard.vue'
import { columnsFor, rowSpan, salon } from './layout'

const props = defineProps<{
  cards: Card[]
  wall: string
  layout: 'salon' | 'grid'
  featuredIds: ReadonlySet<string>
  showOwner: boolean
}>()

const UNIT = 8
const CAPTION = 40

const vw = ref(typeof window !== 'undefined' ? window.innerWidth : 1440)
const containerPx = ref(0)
const root = ref<HTMLElement | null>(null)

const cols = computed(() => columnsFor(vw.value))
// Must mirror the CSS `column-gap: clamp(24px, 4vw, 64px)` below; edit both together.
// Also used as the row gap folded into rowSpan.
const gap = computed(() => Math.min(64, Math.max(24, vw.value * 0.04)))
const columnPx = computed(() => {
  const n = cols.value
  const total = containerPx.value > 0 ? containerPx.value - gap.value * (n - 1) : vw.value
  return Math.max(1, total / n)
})

const aspectOf = (c: Card) => (c.cover && c.cover.width > 0 && c.cover.height > 0 ? c.cover.width / c.cover.height : 1.5)

const placed = computed(() => {
  const items = props.cards.map((c) => ({
    id: c.id,
    aspect: aspectOf(c),
    count: c.count,
    featured: props.featuredIds.has(c.id),
  }))
  const places = salon(items, cols.value)
  return props.cards.map((card, i) => {
    const p = places[i]!
    return {
      card,
      style: {
        gridColumn: `${p.column + 1}`,
        gridRowEnd: `span ${rowSpan(p.widthPct, items[i]!.aspect, columnPx.value, UNIT, CAPTION, gap.value)}`,
        justifySelf: p.align,
        width: `${p.widthPct}%`,
      },
    }
  })
})

const salonStyle = computed(() => ({
  gridTemplateColumns: `repeat(${cols.value}, 1fr)`,
  gridAutoRows: `${UNIT}px`,
}))

const SALON_SIZES = '(max-width: 599px) 100vw, (max-width: 1099px) 50vw, 33vw'
const GRID_SIZES = '(max-width: 599px) 50vw, 300px'

let raf = 0
function onResize() {
  if (raf) return
  const run = () => {
    raf = 0
    vw.value = window.innerWidth
  }
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(run)
  else run()
}

let ro: ResizeObserver | null = null
onMounted(() => {
  window.addEventListener('resize', onResize)
  if (typeof ResizeObserver === 'function' && root.value) {
    ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 0) containerPx.value = w
    })
    ro.observe(root.value)
  }
})
// layout switches the v-if/v-else root, so follow the new container.
watch(root, (el, old) => {
  if (!ro) return
  if (old) ro.unobserve(old)
  if (el) ro.observe(el)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
  ro?.disconnect()
})
</script>

<template>
  <div v-if="layout === 'grid'" ref="root" class="wall grid">
    <div v-for="(card, i) in cards" :key="card.id" class="item">
      <WallCard
        :card="card"
        :wall="wall"
        :show-owner="showOwner"
        :eager="i < 4"
        :high="i === 0"
        :aspect="0.8"
        :sizes="GRID_SIZES"
      />
    </div>
  </div>
  <div v-else ref="root" class="wall salon" :style="salonStyle">
    <div v-for="(p, i) in placed" :key="p.card.id" class="item" :style="p.style">
      <WallCard
        :card="p.card"
        :wall="wall"
        :show-owner="showOwner"
        :eager="i < 4"
        :high="i === 0"
        :aspect="null"
        :sizes="SALON_SIZES"
      />
    </div>
  </div>
</template>

<style scoped>
.wall {
  background: var(--bg-wall);
  padding: var(--space-16);
}
.salon {
  display: grid;
  grid-auto-flow: row dense;
  column-gap: clamp(24px, 4vw, 64px); /* mirrored by `gap` in the script */
  row-gap: 0;
  align-items: start;
}
.salon .item {
  min-width: 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: clamp(24px, 4vw, 64px);
}
@media (max-width: 599px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-16);
  }
}
</style>
