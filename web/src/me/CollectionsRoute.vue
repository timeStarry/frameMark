<script setup lang="ts">
// 我的合集 (SP4a spec §7): the owner's collections from GET /api/u/{me}, in
// wall order, each with its status. A list, not a wall; rows open the viewer
// and each has an 编排 link to the desk (SP4b spec §4.9). 新建合集 asks for a
// title only, creates the draft and opens it on the desk.
import { nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { getUser } from '../api/client'
import { createCollection } from '../api/desk'
import { session } from '../api/session'
import type { Card } from '../api/types'
import Cover from '../walls/Cover.vue'
import WallStatus from '../walls/WallStatus.vue'
import { cardStatus, openCollection } from '../walls/open'
import { usePageHeading } from './pageHeading'

const router = useRouter()
const headingId = `${useId()}-title`
const heading = ref<HTMLElement | null>(null)
usePageHeading(heading, () => '我的合集')

const items = shallowRef<Card[] | null>(null)
const state = ref<'loading' | 'error' | 'idle'>('loading')
// The wall the viewer returns to; fixed to the user the list was loaded for.
const wall = ref('')
let ctrl: AbortController | null = null

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

function deskPath(id: string): string {
  return `/me/c/${encodeURIComponent(id)}`
}

// --- 新建合集 ---

const TITLE_MAX = 120
const dialog = ref<HTMLDialogElement | null>(null)
const createBtn = ref<HTMLButtonElement | null>(null)
const titleInput = ref<HTMLInputElement | null>(null)
const newTitle = ref('')
const creating = ref(false)
const createError = ref('')
const dialogOpen = ref(false)

async function openCreate() {
  newTitle.value = ''
  createError.value = ''
  dialogOpen.value = true
  const d = dialog.value
  if (d && !d.open) {
    try {
      if (typeof d.showModal === 'function') d.showModal()
      else d.setAttribute('open', '')
    } catch {
      d.setAttribute('open', '')
    }
  }
  await nextTick()
  titleInput.value?.focus()
}

async function closeCreate() {
  dialogOpen.value = false
  const d = dialog.value
  if (d) {
    if (typeof d.close === 'function' && d.open) d.close()
    d.removeAttribute('open')
  }
  await nextTick()
  createBtn.value?.focus()
}

function onDialogCancel(e: Event) {
  e.preventDefault()
  if (!creating.value) void closeCreate()
}

async function submitCreate() {
  if (creating.value) return
  const t = newTitle.value.trim()
  if (t === '') {
    createError.value = '请填写标题'
    titleInput.value?.focus()
    return
  }
  creating.value = true
  createError.value = ''
  const r = await createCollection(t)
  creating.value = false
  if (!r.ok) {
    createError.value = r.message
    return
  }
  dialogOpen.value = false
  dialog.value?.removeAttribute('open')
  if (typeof dialog.value?.close === 'function' && dialog.value.open) dialog.value.close()
  await router.push(deskPath(r.data.id))
}

watch(() => session.user, () => void load(), { immediate: true })

onBeforeUnmount(() => {
  ctrl?.abort()
  ctrl = null
})
</script>

<template>
  <main class="me-collections" :aria-labelledby="headingId">
    <div class="head">
      <h1 :id="headingId" ref="heading" tabindex="-1">我的合集</h1>
      <button ref="createBtn" type="button" class="create" @click="openCreate">新建合集</button>
    </div>
    <p class="note">编排和发布在策展台中进行</p>
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
          <RouterLink class="arrange" :to="deskPath(c.id)" :aria-label="`编排 ${c.title}`">编排</RouterLink>
        </li>
      </ul>
      <p v-else class="empty">还没有合集</p>
    </template>
    <WallStatus v-else :state="state" @retry="load" />

    <dialog ref="dialog" class="create-dialog" :aria-labelledby="`${headingId}-new`" @cancel="onDialogCancel">
      <form @submit.prevent="submitCreate">
        <h2 :id="`${headingId}-new`">新建合集</h2>
        <label :for="`${headingId}-new-title`">标题</label>
        <input
          :id="`${headingId}-new-title`"
          ref="titleInput"
          v-model="newTitle"
          name="title"
          type="text"
          autocomplete="off"
          :maxlength="TITLE_MAX"
          required
          :aria-invalid="createError ? 'true' : undefined"
          :aria-describedby="createError ? `${headingId}-new-error` : undefined"
        />
        <p v-if="createError" :id="`${headingId}-new-error`" class="error" role="alert">{{ createError }}</p>
        <div class="actions">
          <button type="button" :disabled="creating" @click="closeCreate">取消</button>
          <button type="submit" class="primary" :disabled="creating" :aria-busy="creating ? 'true' : undefined">创建</button>
        </div>
      </form>
    </dialog>
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
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-16);
}
button,
.arrange {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
  text-decoration: none;
  cursor: pointer;
}
button:disabled {
  cursor: default;
  opacity: 0.6;
}
button:focus-visible,
.arrange:focus-visible,
input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.list li {
  display: flex;
  align-items: center;
  gap: var(--space-16);
}
.list .row {
  flex: 1 1 auto;
  min-width: 0;
}
.create-dialog {
  width: min(420px, calc(100vw - 32px));
  padding: var(--space-24);
  border: 1px solid var(--line);
  background: var(--bg-wall);
  color: var(--fg);
}
.create-dialog::backdrop {
  background: rgba(0, 0, 0, 0.6);
}
.create-dialog form {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
.create-dialog h2 {
  margin: 0 0 var(--space-8);
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 1.25rem;
}
.create-dialog input {
  min-height: 44px;
  padding: 0 var(--space-12);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
}
.create-dialog .error {
  margin: 0;
  color: var(--fg);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-12);
  margin-top: var(--space-16);
}
.primary {
  border-color: var(--fg);
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
