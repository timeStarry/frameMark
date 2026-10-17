<script setup lang="ts">
// `/u/:id` (spec §4.4): name and bio, the collection wall in the owner's
// layout without owner names, then the albums as a uniform grid.
import { shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import type { UserWall } from '../api/types'
import { getUser } from '../api/client'
import Wall from '../walls/Wall.vue'
import WallNav from '../walls/WallNav.vue'
import WallStatus from '../walls/WallStatus.vue'
import Cover from '../walls/Cover.vue'
import WallNotFound from './WallNotFound.vue'
import { useWallPage } from './useWallPage'

const props = defineProps<{ id: string }>()
const wall = `user:${props.id}`
const NO_FEATURED: ReadonlySet<string> = new Set()

const data = shallowRef<UserWall | null>(null)
function show(d: UserWall) {
  data.value = d
  document.title = `${d.profile.name} — Markr`
}

const { state, rootEl, retry } = useWallPage<UserWall, UserWall>({
  wall,
  fetcher: (signal) => getUser(props.id, signal),
  fromCache: show,
  fromFresh: show,
  snapshot: () => data.value,
})
</script>

<template>
  <WallNotFound v-if="state === 'missing'" message="这位摄影师不存在" />
  <template v-else>
    <WallNav />
    <main ref="rootEl" class="wall-page" aria-labelledby="user-title">
      <template v-if="data">
        <header class="head">
          <h1 id="user-title">{{ data.profile.name }}</h1>
          <p v-if="data.profile.bio" class="bio">{{ data.profile.bio }}</p>
        </header>
        <p v-if="data.collections.length === 0" class="empty">还没有公开的照片</p>
        <Wall
          v-else
          :cards="data.collections"
          :wall="wall"
          :layout="data.profile.wallLayout"
          :featured-ids="NO_FEATURED"
          :show-owner="false"
        />
        <section v-if="data.albums.length" class="albums" aria-labelledby="user-albums">
          <h2 id="user-albums">作品集</h2>
          <ul class="album-grid">
            <li v-for="a in data.albums" :key="a.id">
              <RouterLink :to="`/a/${encodeURIComponent(a.id)}`" class="album">
                <Cover :media="a.cover" sizes="(max-width: 599px) 50vw, 300px" :eager="false" :high="false" alt="" :aspect="0.8" />
                <p class="line">{{ a.title }} · {{ a.count }} 组</p>
              </RouterLink>
            </li>
          </ul>
        </section>
      </template>
      <template v-else>
        <h1 id="user-title" class="sr-only">摄影师</h1>
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
.bio {
  margin: var(--space-12) 0 0;
  color: var(--fg-muted);
}
.empty {
  padding: var(--space-48) 0;
  color: var(--fg-muted);
  text-align: center;
}
.albums {
  padding: var(--space-48) var(--space-16) 0;
}
h2 {
  margin: 0 0 var(--space-24);
  font-size: 14px;
  font-weight: 400;
  color: var(--fg-muted);
}
.album-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: clamp(24px, 4vw, 64px);
  margin: 0;
  padding: 0;
  list-style: none;
}
@media (max-width: 599px) {
  .album-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-16);
  }
}
.album {
  display: block;
  min-height: 44px;
  color: var(--fg);
  text-decoration: none;
}
.album:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
.line {
  margin: 0;
  padding-top: var(--space-8);
  line-height: 24px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
