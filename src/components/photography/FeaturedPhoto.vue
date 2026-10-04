<script setup>
import { computed, ref } from 'vue'
import PhotoMedia from './PhotoMedia.vue'
import PhotographerByline from './PhotographerByline.vue'
import { useReveal } from '../../composables/useReveal.js'
import { plainNavigation } from '../../composables/publicBrowse.js'
import { preparePhotoNavigation } from '../../composables/photoTransition.js'
const props = defineProps({ work: { type: Object, required: true } })
const emit = defineEmits(['navigate'])
const root = ref(), picture = ref(), failed = ref(false)
const imageMotion = globalThis.navigator?.connection?.saveData !== true
const media = computed(() => props.work.media?.[0] || { id: props.work.assets[0], width: 22, height: 10 })
const description = computed(() => props.work.text?.trim().split(/\r?\n/).find(Boolean) || props.work.title)
function navigate(event) {
  if (!plainNavigation(event)) return
  emit('navigate', `featured-${props.work.id}`)
  if (event.currentTarget?.getAttribute('href') === `/work/${props.work.id}`) preparePhotoNavigation(event, root.value)
}
function retry() { failed.value = false; picture.value?.retry() }
useReveal(root, () => ({ key: `featured:${props.work.id}` }))
</script>

<template>
  <div ref="root" class="featured-photo" :data-image-motion="imageMotion">
    <router-link :id="`featured-${work.id}`" class="featured-photo__link" :to="`/work/${work.id}`" :aria-label="work.title || '查看精选作品'" @click.capture="navigate">
      <PhotoMedia ref="picture" class="featured-photo__image" :media="media" :alt="work.title || ''" eager fit="cover" :interactive="false" @error="failed = true" @load="failed = false" />
      <div class="featured-photo__shade" aria-hidden="true"></div>
      <p class="featured-photo__description">{{ description }}</p>
    </router-link>
    <div class="featured-photo__author"><PhotographerByline :owner="work.photographer" :name="work.photographerName || ''" @click.capture="navigate" /></div>
    <button v-if="failed" type="button" class="featured-photo__retry" @click="retry">重新加载图片</button>
  </div>
</template>

<style scoped>
.featured-photo { position: relative; margin-bottom: 48px; }
.featured-photo__link { display: block; position: relative; aspect-ratio: 2.2; max-height: 600px; overflow: hidden; color: #fff; }
.featured-photo__image { width: 100%; height: 100%; aspect-ratio: auto; }
.featured-photo__shade { position: absolute; inset: auto 0 0; height: min(100%, 280px); pointer-events: none; background: linear-gradient(0deg, rgb(0 0 0 / .84), rgb(0 0 0 / .72) 160px, transparent 280px); }
.featured-photo__image :deep(.photo-media__loading) { top: 16px; bottom: auto; left: 16px; }
.featured-photo__description { position: absolute; left: 32px; bottom: 66px; max-width: min(640px, calc(100% - 64px)); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: clamp(16px, 1.6vw, 21px); line-height: 1.6; font-weight: 400; color: rgb(255 255 255 / .92); overflow-wrap: anywhere; }
.featured-photo__author { position: absolute; left: 32px; bottom: 20px; max-width: calc(100% - 64px); }
.featured-photo__author :deep(.photographer-byline) { color: rgb(255 255 255 / .9); }
.featured-photo__retry { position: absolute; top: 16px; right: 16px; padding: 8px 14px; min-height: 44px; border: 1px solid var(--markr-line-strong); border-radius: 6px; color: var(--markr-text); background: var(--markr-bg); cursor: pointer; }
@media (hover: hover) and (pointer: fine) { .featured-photo[data-image-motion=true] .featured-photo__image :deep(img) { transition: transform 300ms cubic-bezier(.22,1,.36,1); } .featured-photo[data-image-motion=true] .featured-photo__link:hover :deep(img) { transform: scale(1.01); } }
@media (max-width: 639px) { .featured-photo { margin-bottom: 32px; } .featured-photo__link { aspect-ratio: 1.15; } .featured-photo__description { left: 20px; bottom: 62px; max-width: calc(100% - 40px); font-size: 17px; } .featured-photo__author { left: 20px; bottom: 16px; max-width: calc(100% - 40px); } }
@media (prefers-reduced-motion: reduce) { .featured-photo[data-image-motion=true] .featured-photo__link:hover :deep(img) { transform: none; } }
</style>
