<script setup lang="ts">
// Top edge (spec §5.2): back, title · author, the ⋯ menu (copy link, download
// original when the current photo allows it, author home) and fullscreen.
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Collection, PhotoView } from '../api/types'
import { originalURL } from '../api/client'
import { shareURL } from './urlState'
import { canShare, share } from './share'

const props = defineProps<{
  collection: Collection
  /** The current frame's (first) photo; null on text and end frames. */
  photo: PhotoView | null
  /** 1-based frame for the shared link; omitted on the end frame. */
  frameIndex?: number
  pin(reason: string): void
  unpin(reason: string): void
  /** Fullscreen entry; hidden when unsupported or not provided. */
  fullscreen?: { supported: boolean; active: boolean }
}>()

const emit = defineEmits<{
  exit: []
  fullscreen: []
}>()

const open = ref(false)
const toast = ref('')
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function items(): HTMLElement[] {
  return [...(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
}

/** Read when the menu opens: share where the system sheet exists, else copy (spec §6.3). */
const shareLabel = ref('复制链接')

async function openMenu() {
  shareLabel.value = canShare() ? '分享' : '复制链接'
  open.value = true
  props.pin('menu')
  await nextTick()
  items()[0]?.focus()
}

function closeMenu(restoreFocus: boolean) {
  if (!open.value) return
  open.value = false
  props.unpin('menu')
  if (restoreFocus) trigger.value?.focus()
}

function toggleMenu() {
  if (open.value) closeMenu(true)
  else void openMenu()
}

function onMenuKey(e: KeyboardEvent) {
  const list = items()
  const i = list.indexOf(document.activeElement as HTMLElement)
  let next = -1
  if (e.key === 'ArrowDown') next = (i + 1) % list.length
  else if (e.key === 'ArrowUp') next = (i - 1 + list.length) % list.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = list.length - 1
  else if (e.key === 'Tab') {
    closeMenu(false)
    return
  }
  if (next < 0) return
  e.preventDefault()
  list[next]?.focus()
}

// Capture phase on window: runs before the viewer's own Esc handling, which
// skips events that were already handled.
function onWindowKey(e: KeyboardEvent) {
  if (!open.value || e.key !== 'Escape') return
  e.preventDefault()
  closeMenu(true)
}

function onOutside(e: PointerEvent) {
  if (!open.value) return
  const t = e.target as Node | null
  if (t && (menu.value?.contains(t) || trigger.value?.contains(t))) return
  closeMenu(false)
}

async function copyLink() {
  const url = shareURL(location.origin, props.collection.id, props.frameIndex)
  closeMenu(true)
  const r = await share(url, props.collection.title)
  if (r === 'copied') showToast('已复制链接')
  else if (r === 'failed') showToast('无法复制链接')
}

function showToast(text: string) {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
    toastTimer = null
  }, 1500)
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKey, true)
  document.addEventListener('pointerdown', onOutside, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKey, true)
  document.removeEventListener('pointerdown', onOutside, true)
  if (toastTimer) clearTimeout(toastTimer)
  if (open.value) props.unpin('menu')
})
</script>

<template>
  <div class="top">
    <button type="button" class="icon" aria-label="返回" @click="emit('exit')">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <p class="title">
      <span class="name">{{ collection.title }}</span>
      <span class="sep" aria-hidden="true"> · </span>
      <span class="owner">{{ collection.owner.name }}</span>
    </p>
    <button
      v-if="fullscreen?.supported"
      type="button"
      class="icon"
      :aria-label="fullscreen.active ? '退出全屏' : '全屏'"
      :aria-pressed="fullscreen.active"
      @click="emit('fullscreen')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path v-if="fullscreen.active" d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        <path v-else d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      </svg>
    </button>
    <div class="menu-wrap">
      <button
        ref="trigger"
        type="button"
        class="icon"
        aria-label="更多"
        aria-haspopup="menu"
        :aria-expanded="open ? 'true' : 'false'"
        @click="toggleMenu"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01" /></svg>
      </button>
      <div v-if="open" ref="menu" class="menu" role="menu" aria-label="更多" @keydown="onMenuKey">
        <button type="button" role="menuitem" tabindex="-1" @click="copyLink">{{ shareLabel }}</button>
        <a
          v-if="photo?.downloadable"
          role="menuitem"
          tabindex="-1"
          :href="originalURL(photo.id, collection.id)"
          download
          @click="closeMenu(false)"
          >下载原图</a
        >
        <a role="menuitem" tabindex="-1" :href="`/u/${encodeURIComponent(collection.owner.id)}`">作者主页</a>
      </div>
    </div>
    <p class="toast" role="status">{{ toast }}</p>
  </div>
</template>

<style scoped>
.top {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding:
    max(var(--space-8), env(safe-area-inset-top))
    max(var(--space-12), env(safe-area-inset-right))
    var(--space-8)
    max(var(--space-12), env(safe-area-inset-left));
  background: linear-gradient(rgba(0, 0, 0, 0.55), transparent);
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 14px;
}

.name {
  font-family: var(--font-title);
}

.sep,
.owner {
  color: var(--fg-muted);
}

.icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}

.icon svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.icon:hover,
.icon:focus-visible {
  background: rgba(255, 255, 255, 0.08);
}

.menu-wrap {
  position: relative;
}

.menu {
  position: absolute;
  top: calc(100% + var(--space-4));
  right: 0;
  min-width: 160px;
  padding: var(--space-4) 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #111;
  display: flex;
  flex-direction: column;
}

.menu [role='menuitem'] {
  display: block;
  padding: var(--space-12) var(--space-16);
  border: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 14px;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.menu [role='menuitem']:hover,
.menu [role='menuitem']:focus-visible {
  background: rgba(255, 255, 255, 0.08);
  outline: none;
}

.toast {
  position: absolute;
  top: calc(100% + var(--space-8));
  left: 50%;
  transform: translateX(-50%);
  margin: 0;
  font-size: 13px;
  color: var(--fg);
}

.toast:empty {
  display: none;
}
</style>
