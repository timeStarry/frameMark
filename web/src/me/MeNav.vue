<script setup lang="ts">
// Secondary nav for /me/* (spec §1). RouterLink sets aria-current="page" on the exact match.
import { computed, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { logout, session } from '../api/session'

const router = useRouter()
const error = ref('')
const busy = ref(false)
const home = computed(() => `/u/${encodeURIComponent(session.user ?? '')}`)

async function onLogout(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  const r = await logout()
  busy.value = false
  if (r.ok) {
    await router.replace('/')
    return
  }
  if (r.status !== -1) error.value = r.message
}
</script>

<template>
  <nav class="me-nav" aria-label="工作区">
    <RouterLink to="/me">归档</RouterLink>
    <RouterLink to="/me/collections">合集</RouterLink>
    <RouterLink to="/me/settings">偏好</RouterLink>
    <RouterLink :to="home">我的主页</RouterLink>
    <button type="button" class="logout" :disabled="busy" @click="onLogout">登出</button>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </nav>
</template>

<style scoped>
.me-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: var(--space-24);
  min-height: 44px;
  padding: 0 var(--space-16);
  border-bottom: 1px solid var(--line);
}
a,
.logout {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  min-width: 44px;
  color: var(--fg-muted);
  text-decoration: none;
}
a[aria-current='page'] {
  color: var(--fg);
  text-decoration: underline;
  text-underline-offset: 6px;
}
.logout {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.logout:disabled {
  cursor: progress;
}
a:focus-visible,
.logout:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
.error {
  flex-basis: 100%;
  padding-bottom: var(--space-8);
  color: var(--fg);
}
</style>
