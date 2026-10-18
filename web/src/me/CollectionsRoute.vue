<script setup lang="ts">
// 我的合集 (SP4a spec §7): the owner's collections from GET /api/u/{me}, in
// wall order, each with its status. A list, not a wall; rows open the viewer.
import { onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { useRouter } from 'vue-router'
import { getUser } from '../api/client'
import { session } from '../api/session'
import type { Card } from '../api/types'
import Cover from '../walls/Cover.vue'
import WallStatus from '../walls/WallStatus.vue'
import { cardStatus, openCollection } from '../walls/open'

const router = useRouter()
const headingId = `${useId()}-title`

const items = shallowRef<Card[] | null>(null)
const state = ref<'loading' | 'error' | 'idle'>('loading')
// The wall the viewer returns to; fixed to the user the list was loaded for.
const wall = ref('')
let ctrl: AbortController | null = null

document.title = '合集 — Markr'

async function load(): Promise<void> {
  ctrl?.abort()
  const me = session.user
  if (!me) return
  const c = new AbortController()
  ctrl = c
  state.value = 'loading'
  const r = await getUser(me, c.signal)
  if (ctrl !== c) return
  if (r.ok) {
    items.value = r.data.collections
    wall.value = `user:${me}`
    state.value = 'idle'
    return
  }
  if (r.status === -1) return
  items.value = null
  state.value = 'error'
}

function href(id: string): string {
  return router.resolve({ path: `/c/${encodeURIComponent(id)}`, query: { wall: wall.value } }).href
}

function label(c: Card): string {
  return [c.title, `${c.count} 张`, cardStatus(c)].filter((s): s is string => !!s).join('，')
}

watch(() => session.user, () => void load(), { immediate: true })

onBeforeUnmount(() => {
  ctrl?.abort()
  ctrl = null
  document.title = 'Markr'
})
</script>

<template>
  <main class="me-collections" :aria-labelledby="headingId">
    <h1 :id="headingId">我的合集</h1>
    <p class="note">编排和发布在策展台中进行（即将推出）</p>
    <template v-if="items && state === 'idle'">
      <ul v-if="items.length > 0" class="list">
        <li v-for="c in items" :key="c.id">
          <a
            class="row"
            :href="href(c.id)"
            :data-card-id="c.id"
            :aria-label="label(c)"
            @click="openCollection(router, c.id, wall, $event)"
          >
            <span class="thumb">
              <Cover :media="c.cover" sizes="120px" :eager="false" :high="false" alt="" :aspect="1.5" />
            </span>
            <span class="text">
              <span class="title">{{ c.title }}</span>
              <span class="meta">
                <span class="count">{{ c.count }} 张</span>
                <span v-if="cardStatus(c)" class="status">{{ cardStatus(c) }}</span>
              </span>
            </span>
          </a>
        </li>
      </ul>
      <p v-else class="empty">还没有合集</p>
    </template>
    <WallStatus v-else :state="state" @retry="load" />
  </main>
</template>

<style scoped>
.me-collections {
  max-width: 960px;
  margin: 0 auto;
  padding: var(--space-32) var(--space-16);
}
h1 {
  margin: 0;
  font-family: var(--font-title);
  font-weight: 400;
}
.note,
.empty {
  margin: var(--space-8) 0 0;
  color: var(--fg-muted);
}
.empty {
  padding: var(--space-32) 0;
}
.list {
  margin: var(--space-24) 0 0;
  padding: 0;
  list-style: none;
}
.list li + li {
  border-top: 1px solid var(--line);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--space-16);
  min-height: 44px;
  padding: var(--space-12) 0;
  color: var(--fg);
  text-decoration: none;
}
.row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
.thumb {
  flex: 0 0 120px;
  width: 120px;
}
.text {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}
.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  color: var(--fg-muted);
}
.status {
  padding: 0 var(--space-4);
  border: 1px solid var(--line);
  color: var(--fg-muted);
  font-size: 0.85em;
  line-height: 20px;
}
</style>
