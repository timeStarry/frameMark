<script setup lang="ts">
// 偏好 /me/settings (SP4a spec §8): upload prefs, profile, and sign-out.
// Owns the leave guard: a route-leave confirm and a beforeunload listener
// while either form has unsaved changes.
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { logout, logoutAll } from '../api/session'
import ConfirmDialog from './ConfirmDialog.vue'
import PrefsForm from './PrefsForm.vue'
import ProfileForm from './ProfileForm.vue'
import { usePageHeading } from './pageHeading'

const LEAVE_MESSAGE = '有未保存的修改，确定离开？'

const router = useRouter()
const id = useId()
const headingId = `${id}-title`
const accountId = `${id}-account`

const prefsDirty = ref(false)
const profileDirty = ref(false)
const dirty = computed(() => prefsDirty.value || profileDirty.value)
const heading = ref<HTMLElement | null>(null)
usePageHeading(heading, () => '偏好')

function onBeforeUnload(e: BeforeUnloadEvent): void {
  e.preventDefault()
  // Older browsers need returnValue set to show the prompt.
  e.returnValue = ''
}

let listening = false
function setListener(on: boolean): void {
  if (on === listening) return
  listening = on
  if (on) window.addEventListener('beforeunload', onBeforeUnload)
  else window.removeEventListener('beforeunload', onBeforeUnload)
}
watch(dirty, setListener, { immediate: true })

onBeforeRouteLeave(() => {
  if (!dirty.value) return true
  return window.confirm(LEAVE_MESSAGE)
})

onBeforeUnmount(() => {
  setListener(false)
})

// --- 账户 ---

const busy = ref(false)
const error = ref('')
const confirming = ref(false)
const dialogError = ref('')
const allBtn = ref<HTMLButtonElement | null>(null)

/** Signing out drops the session, so the unsaved-changes prompt is skipped. */
async function leaveHome(): Promise<void> {
  setListener(false)
  prefsDirty.value = false
  profileDirty.value = false
  await router.replace('/')
}

async function onLogout(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  const r = await logout()
  busy.value = false
  if (r.ok) return leaveHome()
  if (r.status !== -1) error.value = r.message
}

function openAll(): void {
  dialogError.value = ''
  confirming.value = true
}

async function closeAll(): Promise<void> {
  confirming.value = false
  await nextTick()
  allBtn.value?.focus()
}

async function onConfirmAll(): Promise<void> {
  if (busy.value) return
  busy.value = true
  dialogError.value = ''
  const r = await logoutAll()
  busy.value = false
  if (r.ok) {
    confirming.value = false
    return leaveHome()
  }
  if (r.status !== -1) {
    dialogError.value = r.message
    error.value = r.message
  }
}
</script>

<template>
  <main class="me-settings" :aria-labelledby="headingId">
    <h1 :id="headingId" ref="heading" tabindex="-1">偏好</h1>
    <PrefsForm @dirty="prefsDirty = $event" />
    <ProfileForm @dirty="profileDirty = $event" />
    <form class="account" :aria-labelledby="accountId" @submit.prevent>
      <h2 :id="accountId">账户</h2>
      <div class="actions">
        <button type="button" :disabled="busy" @click="onLogout">登出</button>
        <button ref="allBtn" type="button" :disabled="busy" @click="openAll">登出全部设备</button>
      </div>
      <p v-if="error && !confirming" class="error" role="alert">{{ error }}</p>
    </form>
    <ConfirmDialog
      title="登出全部设备"
      body="所有设备上的登录都会失效，包括这一台。"
      confirm-label="全部登出"
      :open="confirming"
      :error="dialogError"
      :busy="busy"
      @confirm="onConfirmAll"
      @cancel="closeAll"
    />
  </main>
</template>

<style scoped>
.me-settings {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--space-32) var(--space-16);
}
h1 {
  margin: 0 0 var(--space-24);
  font-family: var(--font-title);
  font-weight: 400;
}
.account {
  display: flex;
  flex-direction: column;
  gap: var(--space-16);
  padding: var(--space-24) 0;
  border-top: 1px solid var(--line);
}
h2 {
  margin: 0;
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 1.25rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-12);
}
.error {
  margin: 0;
}
button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}
button:disabled {
  cursor: default;
  opacity: 0.6;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
