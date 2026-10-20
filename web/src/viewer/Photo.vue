<script setup lang="ts">
// One photo: <picture> with AVIF → WebP → JPEG sources (spec §5.1).
// Outside the render window (`live = false`) only a ratio-keeping box is drawn.
import { computed, ref, watch } from 'vue'
import type { FrameLayout, PhotoView } from '../api/types'
import { sizesFor, srcset } from './media'

const props = defineProps<{
  photo: PhotoView
  layout: FrameLayout
  /** Photos in the frame; drives `sizes`. */
  count: number
  live: boolean
  /** First frame shown: eager load with high fetch priority. */
  priority: boolean
}>()

const failed = ref(false)
watch(
  () => props.photo.media,
  () => {
    failed.value = false
  },
)
// A transient failure gets one fresh attempt each time the frame re-enters the window.
watch(
  () => props.live,
  (live) => {
    if (live) failed.value = false
  },
)

const media = computed(() => props.photo.media)
const w = computed(() => media.value?.width || props.photo.width || 3)
const h = computed(() => media.value?.height || props.photo.height || 2)
const ratio = computed(() => `${w.value} / ${h.value}`)
/** Aspect as a CSS variable, so the placeholder can be sized like the image. */
const boxStyle = computed(() => ({ aspectRatio: ratio.value, '--a': Number((w.value / h.value).toFixed(4)) }))
const sizes = computed(() => sizesFor(props.layout, props.count))
const alt = computed(() => props.photo.title || '照片')
</script>

<template>
  <div v-if="!live" class="placeholder" :style="boxStyle" />
  <div v-else-if="!media || failed" class="placeholder failed" :style="boxStyle">
    <p class="fail">图片暂时无法加载</p>
  </div>
  <picture v-else>
    <source type="image/avif" :srcset="srcset(media, 'avif')" :sizes="sizes" />
    <source type="image/webp" :srcset="srcset(media, 'webp')" :sizes="sizes" />
    <source type="image/jpeg" :srcset="srcset(media, 'jpeg')" :sizes="sizes" />
    <img
      :src="media.tiers.w1280.jpeg"
      :width="w"
      :height="h"
      :alt="alt"
      decoding="async"
      :loading="priority ? 'eager' : 'lazy'"
      :fetchpriority="priority ? 'high' : undefined"
      @error="failed = true"
    />
  </picture>
</template>

<style scoped>
picture {
  display: contents;
}

img,
.placeholder {
  background: var(--bg-view);
}

.failed {
  display: flex;
  align-items: center;
  justify-content: center;
}

.fail {
  font-size: 13px;
  color: var(--fg-muted);
}
</style>
