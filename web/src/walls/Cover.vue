<script setup lang="ts">
// A wall image: <picture> AVIF → WebP → JPEG in a fixed-ratio box (spec §5).
// Null media or a load error keeps the box with a placeholder tone.
import { computed, ref, watch } from 'vue'
import type { ImageFormat, Media, Tier } from '../api/types'
import { srcset, tierWidth } from '../viewer/media'

const props = defineProps<{
  media: Media | null
  sizes: string
  eager: boolean
  high: boolean
  alt: string
  aspect?: number | null
  /** Restrict srcset candidates to these tiers (wall previews use w480/w1280). */
  tiers?: readonly Tier[]
}>()

function set(m: Media, format: ImageFormat): string {
  if (!props.tiers) return srcset(m, format)
  const out: string[] = []
  let last = 0
  for (const t of props.tiers) {
    const w = tierWidth(m, t)
    if (w <= last) continue
    last = w
    out.push(`${m.tiers[t][format]} ${w}w`)
  }
  return out.join(', ')
}

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
      <source type="image/avif" :srcset="set(media, 'avif')" :sizes="sizes" />
      <source type="image/webp" :srcset="set(media, 'webp')" :sizes="sizes" />
      <img
        :srcset="set(media, 'jpeg')"
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
