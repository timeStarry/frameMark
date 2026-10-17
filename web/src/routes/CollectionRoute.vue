<script setup lang="ts">
// /c/:id?wall=&f= (spec §4, §6.3, §6.4): loads the collection and its
// neighbours, keeps `f` and `wall` in the URL, moves between collections with
// history pushes, prefetches the neighbours and owns the document title.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Collection, Neighbors } from '../api/types'
import { getCollection, getNeighbors } from '../api/client'
import { frameQuery, readState } from '../viewer/urlState'
import { remember } from '../viewer/lastViewed'
import { createPreloader, neighborEntries } from '../viewer/preload'
import type { Dir } from '../viewer/gesture'
import Viewer from '../viewer/Viewer.vue'
import ErrorScreen from './ErrorScreen.vue'
import { collectionCache } from './collectionCache'

const props = defineProps<{ id: string }>()
const route = useRoute()
const router = useRouter()

const BASE_TITLE = 'Markr'

/**
 * History state written by in-site entries. `fromWall`: the first viewer entry
 * was pushed from a wall. `viewerDepth`: how many collection pushes since then.
 */
interface ViewerHistoryState {
  fromWall?: boolean
  viewerDepth?: number
}

const collection = shallowRef<Collection | null>(null)
const neighbors = shallowRef<Neighbors | null>(null)
const error = ref<'missing' | 'network' | null>(null)
/** Owner of the collection shown before the current one, for the cross-author flash. */
const fromOwnerId = ref<string | null>(null)
/** Direction of the last horizontal move; picks the transition. */
const slide = ref<Dir>(1)
/** Initial frame for the mounted Viewer; read when the collection changes. */
const initialFrame = ref(1)

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const transitionName = computed(() => (reducedMotion ? 'none' : slide.value > 0 ? 'slide-next' : 'slide-prev'))

const wall = computed(() => neighbors.value?.wall ?? readState(route).wall)
const preloader = createPreloader()
let ctrl: AbortController | null = null

function historyState(): ViewerHistoryState {
  return (router.options.history.state ?? {}) as ViewerHistoryState
}

async function load(id: string) {
  ctrl?.abort()
  const c = new AbortController()
  ctrl = c
  error.value = null
  neighbors.value = null
  initialFrame.value = readState(route).frame

  const prev = collection.value
  const cached = collectionCache.get(id)
  if (cached) collection.value = cached
  else collection.value = null
  if (prev && prev.id !== id) fromOwnerId.value = prev.owner.id

  const nbP = getNeighbors(id, readState(route).wall, c.signal)
  if (!cached) {
    const r = await getCollection(id, c.signal)
    if (c.signal.aborted) return
    if (!r.ok) {
      if (r.status === -1) return
      error.value = r.status === 404 ? 'missing' : 'network'
      return
    }
    collectionCache.put(r.data)
    collection.value = r.data
  }

  const nb = await nbP
  if (c.signal.aborted) return
  // Neighbours are optional: without them the viewer still works, minus the strip and next.
  neighbors.value = nb.ok ? nb.data : null
  if (nb.ok && nb.data.wall !== readState(route).wall) {
    void router.replace({ query: { ...route.query, wall: nb.data.wall } })
  }
  if (nb.ok) prefetchNeighbors(nb.data)
}

function prefetchNeighbors(nb: Neighbors) {
  preloader.clear()
  const entries = [nb.next, nb.prev].filter((x) => x !== null)
  void Promise.all(entries.map((card) => collectionCache.prefetch(card.id))).then((cols) => {
    if (neighbors.value !== nb) return // moved on meanwhile
    // Preload each neighbour's first frame (neighborEntries around frame 0 yields frame 1).
    preloader.set(cols.flatMap((col) => (col ? neighborEntries(col.frames, 0).map((e) => ({ ...e, key: `${col.id}:${e.key}` })) : [])))
  })
}

// Before the id watcher, and immediate: a cache hit sets collection synchronously during setup.
watch(
  collection,
  (c) => {
    document.title = c ? `${c.title} · ${c.owner.name} — ${BASE_TITLE}` : BASE_TITLE
  },
  { immediate: true },
)

watch(
  () => props.id,
  (id, old) => {
    if (old && collection.value && wall.value) remember(wall.value, old)
    void load(id)
  },
  { immediate: true },
)

function onFrame(n: number) {
  void router.replace({ query: { ...route.query, ...frameQuery(n) } })
}

function pushCollection(id: string, dir: Dir) {
  slide.value = dir
  const st = historyState()
  const query: Record<string, string> = {}
  if (wall.value) query.wall = wall.value
  void router.push({
    path: `/c/${encodeURIComponent(id)}`,
    query,
    state: { fromWall: st.fromWall === true, viewerDepth: (st.viewerDepth ?? 0) + 1 },
  })
}

function onNavigate(dir: Dir) {
  const target = dir > 0 ? neighbors.value?.next : neighbors.value?.prev
  if (target) pushCollection(target.id, dir)
}

function onJump(id: string) {
  const strip = neighbors.value?.strip ?? []
  const from = strip.findIndex((c) => c.id === props.id)
  const to = strip.findIndex((c) => c.id === id)
  pushCollection(id, to >= 0 && from >= 0 && to < from ? -1 : 1)
}

function onExit() {
  const st = historyState()
  // Back past every collection pushed in the viewer to the wall itself.
  if (st.fromWall) router.go(-((st.viewerDepth ?? 0) + 1))
  else void router.push('/')
}

function retry() {
  void load(props.id)
}

onBeforeUnmount(() => {
  ctrl?.abort()
  preloader.clear()
  if (collection.value && wall.value) remember(wall.value, collection.value.id)
  document.title = BASE_TITLE
})
</script>

<template>
  <ErrorScreen v-if="error" :kind="error" @retry="retry" />
  <div v-else class="route">
    <Transition :name="transitionName">
      <Viewer
        v-if="collection"
        :key="collection.id"
        class="layer"
        :collection="collection"
        :neighbors="neighbors"
        :initial-frame="initialFrame"
        :from-owner-id="fromOwnerId"
        mode="public"
        @frame="onFrame"
        @navigate="onNavigate"
        @jump="onJump"
        @exit="onExit"
      />
    </Transition>
  </div>
</template>

<style scoped>
.route {
  position: relative;
  width: 100%;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg-view);
}

.layer {
  position: absolute;
  inset: 0;
}

.slide-next-enter-active,
.slide-next-leave-active,
.slide-prev-enter-active,
.slide-prev-leave-active {
  transition: transform var(--dur-move) var(--ease-move);
}

.slide-next-enter-from,
.slide-prev-leave-to {
  transform: translateX(100%);
}

.slide-next-leave-to,
.slide-prev-enter-from {
  transform: translateX(-100%);
}
</style>
