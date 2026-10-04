<script setup>
import { computed, ref } from 'vue'
import PhotoMedia from './PhotoMedia.vue'
import PhotographerByline from './PhotographerByline.vue'
import { useReveal } from '../../composables/useReveal.js'
import { photoFocusId, plainNavigation } from '../../composables/publicBrowse.js'
import { preparePhotoNavigation } from '../../composables/photoTransition.js'

const props = defineProps({
  work: { type: Object, required: true }, index: { type: Number, default: 0 },
  showAuthor: { type: Boolean, default: true }, append: Boolean, eager: Boolean, revealKey: { type: String, default: '' },
})
const emit = defineEmits(['navigate'])
const tile = ref(), mediaElement = ref(), failed = ref(false)
const imageMotion = globalThis.navigator?.connection?.saveData !== true
const media = computed(() => props.work.coverMedia || props.work.media?.[0] || (props.work.assets?.[0] ? { id: props.work.assets[0], width: 4, height: 3 } : null))
const ratio = computed(() => {
  const value = media.value?.width / media.value?.height
  return Number.isFinite(value) && value > 0 ? Math.min(2.5, Math.max(.65, value)) : 1.4
})
const destination = computed(() => `/${props.work.kind === 'collection' ? 'collection' : 'work'}/${props.work.id}`)
const count = computed(() => props.work.assets?.length || 0)
function navigate(event) {
  if (!plainNavigation(event)) return
  emit('navigate', photoFocusId(props.work))
  if (event.currentTarget?.getAttribute('href') === destination.value) preparePhotoNavigation(event, tile.value)
}
function retry() { failed.value = false; mediaElement.value?.retry() }
useReveal(tile, () => ({ key: `${props.revealKey}:${props.work.id}`, index: props.append ? props.index % 12 : props.index, append: props.append }))
</script>

<template>
  <article ref="tile" class="photo-tile" :data-image-motion="imageMotion" :style="{ '--photo-ratio': ratio }">
    <router-link :id="photoFocusId(work)" class="photo-tile__link" :to="destination" :aria-label="work.title || '查看作品'" @click.capture="navigate">
      <PhotoMedia v-if="media" ref="mediaElement" class="photo-tile__media" :style="{ aspectRatio: ratio }" :media="media" :alt="work.title || ''" :eager="eager" :interactive="false" @error="failed = true" @load="failed = false" />
      <div v-else class="photo-tile__text"><p>{{ work.text || work.title || '作品集' }}</p></div>
    </router-link>
    <div class="photo-tile__caption">
      <router-link class="photo-tile__title" :to="destination" @click.capture="navigate">{{ work.title || (work.kind === 'collection' ? '作品集' : '作品') }}</router-link>
      <span v-if="count > 1" class="photo-tile__count" :aria-label="`${count} 张照片`">{{ count }} 张</span>
    </div>
    <PhotographerByline v-if="showAuthor" :owner="work.photographer" :name="work.photographerName || ''" @click.capture="navigate" />
    <button v-if="failed" type="button" class="photo-tile__retry" :aria-label="`重新加载${work.title || '作品'}的图片`" @click="retry">重新加载图片</button>
  </article>
</template>

<style scoped>
.photo-tile { flex: var(--photo-ratio) 1 calc(var(--photo-ratio) * 270px); min-width: 0; max-width: 100%; }
.photo-tile__link { display: block; color: inherit; text-decoration: none; }
.photo-tile__media { aspect-ratio: var(--photo-ratio); }
.photo-tile__media :deep(.photo-media__image) { object-fit: contain; }
.photo-tile__text { aspect-ratio: 1.4; display: flex; align-items: center; background: var(--markr-surface); padding: clamp(24px, 3vw, 40px); overflow: hidden; }
.photo-tile__text p { display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; font-size: 17px; line-height: 1.9; color: var(--markr-text); overflow-wrap: anywhere; white-space: pre-wrap; }
.photo-tile__caption { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding-top: 12px; }
.photo-tile__title { color: var(--markr-text); text-decoration: none; font-size: 14px; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.photo-tile__count { flex: none; font-size: 12px; color: var(--markr-muted); }
.photo-tile__retry { display: block; min-height: 44px; padding: 0; border: 0; background: transparent; color: var(--markr-text); font-size: 12px; text-decoration: underline; text-underline-offset: 4px; cursor: pointer; }
@media (hover: hover) and (pointer: fine) {
  .photo-tile__title:hover { text-decoration: underline; text-underline-offset: 4px; }
  .photo-tile[data-image-motion=true] .photo-tile__media :deep(img) { transition: transform 300ms cubic-bezier(.22,1,.36,1); }
  .photo-tile[data-image-motion=true] .photo-tile__link:hover :deep(img) { transform: scale(1.01); }
}
@media (max-width: 639px) { .photo-tile { flex: 0 0 100%; } .photo-tile__caption { padding-top: 10px; } }
@media (prefers-reduced-motion: reduce) { .photo-tile[data-image-motion=true] .photo-tile__link:hover :deep(img) { transform: none; } }
</style>
