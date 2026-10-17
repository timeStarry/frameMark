<script setup lang="ts">
// A wall image: <picture> AVIF → WebP → JPEG in a fixed-ratio box (spec §5).
// Null media or a load error keeps the box with a placeholder tone.
import { computed, ref, watch } from 'vue'
import type { Media } from '../api/types'
import { srcset } from '../viewer/media'

const props = defineProps<{
  media: Media | null
  sizes: string
  eager: boolean
  high: boolean
  alt: string
  aspect?: number | null
}>()

const failed = ref(false)
watch(
  () => props.media,
  () => {
    failed.value = false
  },
)

const ratio = computed(() => {
  if (props.aspect) return props.aspect
  const m = props.media
  const a = m && m.width > 0 && m.height > 0 ? m.width / m.height : 1.5
  return Math.min(a, 2.4)
})
</script>

<template>
  <div class="cover" :class="{ failed: !media || failed }" :style="{ aspectRatio: String(ratio) }">
    <picture v-if="media && !failed">
      <source type="image/avif" :srcset="srcset(media, 'avif')" :sizes="sizes" />
      <source type="image/webp" :srcset="srcset(media, 'webp')" :sizes="sizes" />
      <img
        :srcset="srcset(media, 'jpeg')"
        :src="media.tiers.w1280.jpeg"
        :sizes="sizes"
        :alt="alt"
        :loading="eager ? 'eager' : 'lazy'"
        :fetchpriority="high ? 'high' : 'auto'"
        decoding="async"
        @error="failed = true"
      />
    </picture>
  </div>
</template>

<style scoped>
.cover {
  position: relative;
  width: 100%;
  overflow: hidden;
  background: var(--line);
}
picture {
  display: block;
  width: 100%;
  height: 100%;
}
img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
