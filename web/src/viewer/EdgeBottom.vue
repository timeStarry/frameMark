<script setup lang="ts">
// Bottom edge (spec §5.2): the neighbouring collections' cover strip, current
// one highlighted. Not rendered with one collection or fewer.
import { onMounted, ref } from 'vue'
import type { Card } from '../api/types'
import { srcset } from './media'

defineProps<{ collectionId: string; strip: Card[] }>()
const emit = defineEmits<{ jump: [id: string] }>()

const list = ref<HTMLElement | null>(null)
// A long strip on a narrow screen starts scrolled to the current card. Only the
// strip scrolls: scrollIntoView would also scroll .route while the new viewer
// is still sliding in at translateX(100%), breaking the slide (N1).
onMounted(() => {
  const el = list.value
  const card = el?.querySelector<HTMLElement>('[aria-current="true"]')
  if (!el || !card) return
  // The browser clamps to [0, scrollWidth - clientWidth].
  el.scrollLeft = card.offsetLeft - (el.clientWidth - card.offsetWidth) / 2
})
</script>

<template>
  <nav v-if="strip.length > 1" class="bottom" aria-label="更多合集">
    <ul ref="list" class="strip">
      <li v-for="c in strip" :key="c.id">
        <button
          type="button"
          class="card"
          :aria-current="c.id === collectionId ? 'true' : undefined"
          :aria-label="`${c.title} · ${c.owner.name}`"
          @click="c.id !== collectionId && emit('jump', c.id)"
        >
          <picture v-if="c.cover">
            <source type="image/avif" :srcset="srcset(c.cover, 'avif')" sizes="96px" />
            <source type="image/webp" :srcset="srcset(c.cover, 'webp')" sizes="96px" />
            <img :src="c.cover.tiers.w480.jpeg" alt="" loading="lazy" decoding="async" />
          </picture>
          <span v-else class="blank" />
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.bottom {
  padding:
    var(--space-8)
    max(var(--space-12), env(safe-area-inset-right))
    max(var(--space-12), env(safe-area-inset-bottom))
    max(var(--space-12), env(safe-area-inset-left));
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.55));
}

.strip {
  display: flex;
  /* Centred by auto margins on the end cards, not justify-content: center,
     which pushes an overflowing strip past the scroll origin and clips it. */
  gap: var(--space-8);
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-x: auto;
  scrollbar-width: none;
}

.strip > li:first-child {
  margin-left: auto;
}

.strip > li:last-child {
  margin-right: auto;
}

.card {
  display: block;
  width: 72px;
  height: 48px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 3px;
  background: #111;
  overflow: hidden;
  opacity: 0.55;
  cursor: pointer;
  transition: opacity var(--dur-fade);
}

.card:hover,
.card:focus-visible {
  opacity: 0.9;
}

.card[aria-current='true'] {
  opacity: 1;
  border-color: var(--fg);
  cursor: default;
}

.card img,
.blank {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
