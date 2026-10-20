<script setup lang="ts">
// `/` (spec §4.3): featured first (full width), then the latest with featured
// duplicates removed; infinite scroll via a sentinel, with a load-more button
// as the keyboard / no-IntersectionObserver trigger.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { Card, SquarePage } from '../api/types'
import { getSquare } from '../api/client'
import Wall from '../walls/Wall.vue'
import WallNav from '../walls/WallNav.vue'
import WallStatus from '../walls/WallStatus.vue'
import { useWallPage } from './useWallPage'

type Snapshot = SquarePage

const WALL = 'square'
document.title = 'Markr'

const featured = shallowRef<Card[]>([])
const items = shallowRef<Card[]>([])
const nextCursor = ref<string | null>(null)
const loaded = ref(false)

const featuredIds = computed(() => new Set(featured.value.map((c) => c.id)))
const cards = computed(() => [...featured.value, ...items.value.filter((c) => !featuredIds.value.has(c.id))])

function set(s: Snapshot) {
  featured.value = s.featured
  items.value = s.items
  nextCursor.value = s.nextCursor
  loaded.value = true
}

const { state, rootEl, retry } = useWallPage<SquarePage, Snapshot>({
  wall: WALL,
  fetcher: (signal) => getSquare(null, signal),
  fromCache: set,
  fromFresh: (fresh, hadCache) => {
    if (!hadCache) return set(fresh)
    // Only prepend cards the cached wall does not have; never reorder.
    const known = new Set(cards.value.map((c) => c.id))
    const added = fresh.items.filter((c) => !known.has(c.id))
    if (added.length) items.value = [...added, ...items.value]
  },
  snapshot: () => (loaded.value ? { featured: featured.value, items: items.value, nextCursor: nextCursor.value } : null),
})

// Next pages.
const moreState = ref<'idle' | 'loading' | 'error'>('idle')
let moreCtrl: AbortController | null = null

async function more() {
  const cursor = nextCursor.value
  if (!cursor || moreState.value === 'loading') return
  moreState.value = 'loading'
  const c = new AbortController()
  moreCtrl = c
  const r = await getSquare(cursor, c.signal)
  if (c.signal.aborted) return
  if (!r.ok) {
    moreState.value = r.status === -1 ? 'idle' : 'error'
    return
  }
  const known = new Set(cards.value.map((x) => x.id))
  items.value = [...items.value, ...r.data.items.filter((x) => !known.has(x.id))]
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

onBeforeUnmount(() => {
  io?.disconnect()
  moreCtrl?.abort()
})
</script>

<template>
  <WallNav />
  <main ref="rootEl" class="wall-page" aria-labelledby="square-title">
    <h1 id="square-title" class="sr-only">广场</h1>
    <template v-if="loaded">
      <p v-if="cards.length === 0" class="empty">还没有公开的照片</p>
      <template v-else>
        <Wall :cards="cards" :wall="WALL" layout="salon" :featured-ids="featuredIds" :show-owner="true" />
        <template v-if="nextCursor">
          <WallStatus :state="moreState" @retry="more" />
          <div ref="sentinel" class="sentinel" aria-hidden="true" />
          <p v-if="moreState === 'idle'" class="more">
            <button type="button" @click="more">载入更多</button>
          </p>
        </template>
      </template>
    </template>
    <WallStatus v-else :state="state === 'error' ? 'error' : 'loading'" @retry="retry" />
  </main>
</template>

<style scoped>
.wall-page {
  max-width: 1440px;
  margin: 0 auto;
  padding: 0 max(16px, 4vw) var(--space-48);
  background: var(--bg-wall);
  min-height: 100vh;
}
.empty {
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
  font: inherit;
  cursor: pointer;
}
.more button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
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
