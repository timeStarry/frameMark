<script setup lang="ts">
// `/a/:id` (spec §4.4): title, intro, owner link, then the member wall (salon).
import { shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import type { AlbumPage } from '../api/types'
import { getAlbum } from '../api/client'
import Wall from '../walls/Wall.vue'
import WallNav from '../walls/WallNav.vue'
import WallStatus from '../walls/WallStatus.vue'
import WallNotFound from './WallNotFound.vue'
import { useWallPage } from './useWallPage'

const props = defineProps<{ id: string }>()
const wall = `album:${props.id}`
const NO_FEATURED: ReadonlySet<string> = new Set()

const data = shallowRef<AlbumPage | null>(null)
function show(d: AlbumPage) {
  data.value = d
  document.title = `${d.title} · ${d.owner.name} — Markr`
}

const { state, rootEl, retry } = useWallPage<AlbumPage, AlbumPage>({
  wall,
  fetcher: (signal) => getAlbum(props.id, signal),
  fromCache: show,
  fromFresh: show,
  snapshot: () => data.value,
})
</script>

<template>
  <WallNotFound v-if="state === 'missing'" message="这组作品不存在或已不再公开" />
  <template v-else>
    <WallNav />
    <main ref="rootEl" class="wall-page" aria-labelledby="album-title">
      <template v-if="data">
        <header class="head">
          <h1 id="album-title">{{ data.title }}</h1>
          <p v-if="data.intro" class="intro">{{ data.intro }}</p>
          <p class="owner">
            <RouterLink :to="`/u/${encodeURIComponent(data.owner.id)}`">{{ data.owner.name }}</RouterLink>
          </p>
        </header>
        <p v-if="data.members.length === 0" class="empty">还没有公开的照片</p>
        <Wall v-else :cards="data.members" :wall="wall" layout="salon" :featured-ids="NO_FEATURED" :show-owner="true" />
      </template>
      <template v-else>
        <h1 id="album-title" class="sr-only">作品集</h1>
        <WallStatus :state="state === 'error' ? 'error' : 'loading'" @retry="retry" />
      </template>
    </main>
  </template>
</template>

<style scoped>
.wall-page {
  max-width: 1440px;
  margin: 0 auto;
  padding: 0 max(16px, 4vw) var(--space-48);
  background: var(--bg-wall);
  min-height: 100vh;
}
.head {
  padding: var(--space-48) var(--space-16) var(--space-24);
}
h1 {
  margin: 0;
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 32px;
}
.intro {
  margin: var(--space-12) 0 0;
  color: var(--fg-muted);
}
.owner {
  margin: var(--space-8) 0 0;
}
.owner a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: var(--fg-muted);
  text-decoration: none;
}
.owner a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
.empty {
  padding: var(--space-48) 0;
  color: var(--fg-muted);
  text-align: center;
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
