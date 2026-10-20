<script setup lang="ts">
// 访客视角 (spec §4.4): the SP2 Viewer in preview mode, rendered at a 390×844
// phone size and scaled with a CSS transform to fit the column. The collection
// is the desk's visitor-shaped preview (effective public fields only). The
// Viewer itself never writes the URL or lastViewed (CollectionRoute does);
// its frame / exit / navigate / jump emits are deliberately not listened to.
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'
import type { Collection } from '../api/types'
import Viewer from '../viewer/Viewer.vue'

defineProps<{ collection: Collection | null; initialFrame: number }>()

const W = 390
const H = 844
const uid = useId()
const fit = ref<HTMLElement | null>(null)
const scale = ref(1)

function measure() {
  const el = fit.value
  if (!el) return
  const w = el.clientWidth
  const h = el.clientHeight
  // An unlaid-out box (tests, a hidden column) keeps the natural size.
  if (w <= 0) return
  scale.value = Math.min(1, w / W, h > 0 ? h / H : Infinity)
}

// The Viewer reads keys on window (viewer/input.ts), so ↑/↓, Space, i, f and
// Esc pressed anywhere on the desk would also drive the preview. This
// listener is added during setup, before the Viewer mounts and binds its own,
// so on the same target it runs first: a key from outside the preview never
// reaches the Viewer. Element handlers (sequence, archive) and the desk's
// document-level shortcuts have already run by then.
const root = ref<HTMLElement | null>(null)
function fenceKeys(e: KeyboardEvent) {
  const t = e.target as Node | null
  if (t && root.value?.contains(t)) return
  e.stopImmediatePropagation()
}
window.addEventListener('keydown', fenceKeys)
onBeforeUnmount(() => window.removeEventListener('keydown', fenceKeys))

let ro: ResizeObserver | null = null
onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'function' && fit.value) {
    ro = new ResizeObserver(measure)
    ro.observe(fit.value)
  }
})
onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <section ref="root" class="desk-preview" :aria-labelledby="`${uid}-h`" data-desk-preview>
    <h2 :id="`${uid}-h`">访客视角</h2>
    <div ref="fit" class="fit">
      <div class="frame" :style="{ width: `${W * scale}px`, height: `${H * scale}px` }">
        <div class="phone" :style="{ width: `${W}px`, height: `${H}px`, transform: `scale(${scale})` }">
          <Viewer
            v-if="collection && collection.frames.length > 0"
            :key="`${collection.id}:${initialFrame}`"
            :collection="collection"
            :neighbors="null"
            :initial-frame="initialFrame"
            :active="true"
            mode="preview"
          />
          <p v-else class="empty">序列为空，访客将看不到内容</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.desk-preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  min-width: 0;
  height: 100%;
}
h2 {
  margin: 0;
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 1.125rem;
}
.fit {
  flex: 1 1 auto;
  display: flex;
  justify-content: center;
  min-height: 0;
}
.frame {
  overflow: hidden;
  border: 1px solid var(--line);
}
.phone {
  position: relative;
  transform-origin: 0 0;
  background: var(--bg-view);
  /* Keep the Viewer's fixed layers inside the phone box. */
  contain: layout paint;
}
.phone :deep(.viewer) {
  height: 100%;
}
.empty {
  margin: 0;
  padding: var(--space-48) var(--space-16);
  color: var(--fg-muted);
  text-align: center;
}
</style>
