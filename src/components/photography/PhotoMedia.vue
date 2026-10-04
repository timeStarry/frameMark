<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

// Shared display image. Set interactive=false inside a link; its parent can
// respond to error(mediaId) with a separate button calling the exposed retry().
// A parent may override .photo-media height/aspect-ratio for a fixed image stage.
const props = defineProps({
  media: { type: Object, required: true },
  alt: { type: String, default: '' },
  eager: { type: Boolean, default: false },
  fit: { type: String, default: 'contain', validator: value => ['contain', 'cover'].includes(value) },
  interactive: { type: Boolean, default: true },
})
const emit = defineEmits(['load', 'error'])
const image = ref(null)
const state = ref('loading')
const requestVersion = ref(0)
const attempt = ref(0)
const animate = ref(false)
let disposed = false

const mediaId = computed(() => typeof props.media?.id === 'string' ? props.media.id : '')
const dimensions = computed(() => {
  const width = Number(props.media?.width), height = Number(props.media?.height)
  const valid = value => Number.isFinite(value) && value >= 1 && value <= 100000
  return valid(width) && valid(height)
    ? { width: Math.round(width), height: Math.round(height) }
    : { width: 1600, height: 1200 }
})
const source = computed(() => mediaId.value
  ? `/api/media/${encodeURIComponent(mediaId.value)}/display${attempt.value ? `?retry=${attempt.value}` : ''}`
  : null)

function begin() {
  requestVersion.value += 1
  state.value = mediaId.value ? 'loading' : 'error'
  animate.value = false
}
watch(mediaId, () => { attempt.value = 0; begin() }, { immediate: true, flush: 'sync' })

function isCurrent(target, version) {
  return !disposed && target === image.value && version === requestVersion.value
    && target?.dataset.request === String(version)
}
async function loaded(event) {
  const target = event.currentTarget, version = requestVersion.value, id = mediaId.value
  if (!isCurrent(target, version)) return
  // Decoding is optional enhancement. A decode failure must not conceal an
  // image whose native load event has already succeeded.
  if (typeof target.decode === 'function') {
    try { await target.decode() } catch { /* The loaded image remains visible. */ }
  }
  if (!isCurrent(target, version)) return
  state.value = 'loaded'
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const saveData = typeof navigator !== 'undefined' && navigator.connection?.saveData
  animate.value = !reduceMotion && !saveData
  emit('load', id)
}
function failed(event) {
  if (!isCurrent(event.currentTarget, requestVersion.value)) return
  state.value = 'error'
  animate.value = false
  emit('error', mediaId.value)
}
function retry() {
  if (!mediaId.value) return
  attempt.value += 1
  begin()
}
defineExpose({ retry })
onBeforeUnmount(() => { disposed = true; requestVersion.value += 1 })
</script>

<template>
  <div class="photo-media" :class="{ 'photo-media--error': state === 'error', 'photo-media--decoded': animate }" :style="{ '--photo-ratio': `${dimensions.width} / ${dimensions.height}` }" :aria-busy="state === 'loading'" :data-photo-state="state">
    <img v-if="source" :key="requestVersion" ref="image" class="photo-media__image" :src="source" :alt="alt" :width="dimensions.width" :height="dimensions.height" :loading="eager ? 'eager' : 'lazy'" :fetchpriority="eager ? 'high' : 'auto'" decoding="async" :data-request="requestVersion" :data-photo-id="mediaId" :style="{ objectFit: fit }" @load="loaded" @error="failed">
    <span v-if="state === 'loading'" class="photo-media__loading" role="status">正在载入照片…</span>
    <div v-else-if="state === 'error'" class="photo-media__error">
      <span role="status">照片暂时无法载入</span>
      <button v-if="interactive && source" type="button" class="photo-media__retry" @click.stop="retry">重新载入</button>
    </div>
  </div>
</template>

<style scoped>
.photo-media{position:relative;display:block;width:100%;min-width:0;aspect-ratio:var(--photo-ratio,4 / 3);overflow:hidden;background:var(--markr-surface,#121416);isolation:isolate}
.photo-media__image{position:absolute;inset:0;display:block;width:100%;height:100%;color:var(--markr-muted,#a0a4a8);font-size:13px;opacity:1}
.photo-media__loading{position:absolute;bottom:12px;left:12px;max-width:calc(100% - 24px);padding:4px 8px;color:#eeeee9;background:rgba(9,10,11,.84);font-size:12px;line-height:1.5;pointer-events:none}
.photo-media--error .photo-media__image{visibility:hidden}
.photo-media__error{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px;text-align:center;color:var(--markr-muted,#a0a4a8);font-size:13px;line-height:1.7}
.photo-media__retry{min-height:44px;padding:8px 14px;border:1px solid var(--markr-line-strong,#41494d);border-radius:6px;background:transparent;color:var(--markr-text,#eeeee9);font:inherit;cursor:pointer;transition:border-color 140ms cubic-bezier(.2,0,0,1)}
.photo-media__retry:hover{border-color:var(--markr-muted,#a0a4a8)}
.photo-media__retry:focus-visible{outline:2px solid var(--markr-accent,#ccd4c4);outline-offset:3px}
.photo-media--decoded .photo-media__image{animation:photo-resolve 180ms cubic-bezier(.2,0,0,1)}
@keyframes photo-resolve{from{opacity:.72}to{opacity:1}}
@media(prefers-reduced-motion:reduce){.photo-media--decoded .photo-media__image{animation:none}.photo-media__retry{transition:none}}
</style>
