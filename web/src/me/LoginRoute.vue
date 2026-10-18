<script setup lang="ts">
// /login: sign in, register, or set a password from a #verify= link (spec §4).
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { login, register, session, verify } from '../api/session'
import WallNav from '../walls/WallNav.vue'
import { safeNext } from './guard'

const route = useRoute()
const router = useRouter()

// Read the verify token and strip it from the address bar before anything
// else runs. It lives only in this closure: never in storage, logs or the URL.
const VERIFY = '#verify='
let token = ''
if (location.hash.startsWith(VERIFY)) {
  const raw = location.hash.slice(VERIFY.length)
  try {
    token = decodeURIComponent(raw)
  } catch {
    token = raw
  }
  history.replaceState(null, '', location.pathname + location.search)
  // Keep vue-router's own copy of the location in step, or its next push
  // would write the old (token-bearing) URL back into this history entry.
  if (route.hash) void router.replace({ path: route.path, query: route.query, hash: '' })
}
const verifying = token !== ''

type Tab = 'login' | 'register'
const TABS: { id: Tab; label: string }[] = [
  { id: 'login', label: '登录' },
  { id: 'register', label: '注册' },
]
const tab = ref<Tab>('login')
const tabEls = ref<HTMLButtonElement[]>([])

const title = computed(() => (verifying ? '设置密码' : tab.value === 'login' ? '登录' : '注册'))

const email = ref('')
const password = ref('')
const showPassword = ref(false)
const error = ref('')
const notice = ref('')
const busy = ref(false)

const MIN_PASSWORD = 15
const PASSWORD_HINT = '至少 15 个字符'

function select(next: Tab): void {
  if (tab.value === next) return
  tab.value = next
  password.value = ''
  showPassword.value = false
  error.value = ''
  notice.value = ''
}

function onTabKey(e: KeyboardEvent, i: number): void {
  let j: number
  if (e.key === 'ArrowRight') j = (i + 1) % TABS.length
  else if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length
  else if (e.key === 'Home') j = 0
  else if (e.key === 'End') j = TABS.length - 1
  else return
  e.preventDefault()
  select(TABS[j]!.id)
  tabEls.value[j]?.focus()
}

async function done(): Promise<void> {
  await router.replace(safeNext(route.query.next))
}

async function onLogin(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  const r = await login(email.value.trim(), password.value)
  busy.value = false
  if (r.ok) return done()
  if (r.status !== -1) error.value = r.message
}

async function onRegister(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  const r = await register(email.value.trim())
  busy.value = false
  if (r.ok) {
    const m = (r.data as { message?: unknown } | null)?.message
    notice.value = typeof m === 'string' ? m : ''
    return
  }
  if (r.status !== -1) error.value = r.message
}

async function onVerify(): Promise<void> {
  if (busy.value) return
  error.value = ''
  if ([...password.value].length < MIN_PASSWORD) {
    error.value = PASSWORD_HINT
    return
  }
  busy.value = true
  const r = await verify(token, password.value)
  busy.value = false
  if (r.ok) {
    token = ''
    return done()
  }
  if (r.status !== -1) error.value = r.message
}

</script>

<template>
  <WallNav />
  <main class="login" aria-labelledby="login-title">
    <h1 id="login-title">{{ title }}</h1>

    <form v-if="verifying" class="form" novalidate @submit.prevent="onVerify">
      <div class="field">
        <label for="verify-password">新密码</label>
        <div class="pw">
          <input
            id="verify-password"
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            aria-describedby="verify-hint"
            required
          />
          <button type="button" class="toggle" :aria-pressed="showPassword" @click="showPassword = !showPassword">
            {{ showPassword ? '隐藏' : '显示' }}
          </button>
        </div>
        <p id="verify-hint" class="hint">{{ PASSWORD_HINT }}</p>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="submit" class="submit" :disabled="busy">设置密码并登录</button>
    </form>

    <template v-else>
      <div class="tabs" role="tablist" aria-label="登录或注册">
        <button
          v-for="(t, i) in TABS"
          :id="`tab-${t.id}`"
          :key="t.id"
          ref="tabEls"
          type="button"
          role="tab"
          class="tab"
          :aria-selected="tab === t.id"
          :aria-controls="`panel-${t.id}`"
          :tabindex="tab === t.id ? 0 : -1"
          @click="select(t.id)"
          @keydown="onTabKey($event, i)"
        >
          {{ t.label }}
        </button>
      </div>

      <div :id="`panel-${tab}`" role="tabpanel" :aria-labelledby="`tab-${tab}`" class="panel">
        <form v-if="tab === 'login'" class="form" novalidate @submit.prevent="onLogin">
          <div class="field">
            <label for="login-email">邮箱</label>
            <input id="login-email" v-model="email" type="email" autocomplete="email" required />
          </div>
          <div class="field">
            <label for="login-password">密码</label>
            <div class="pw">
              <input
                id="login-password"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                required
              />
              <button type="button" class="toggle" :aria-pressed="showPassword" @click="showPassword = !showPassword">
                {{ showPassword ? '隐藏' : '显示' }}
              </button>
            </div>
          </div>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <button type="submit" class="submit" :disabled="busy">登录</button>
        </form>

        <p v-else-if="!session.registrationOpen" class="closed">注册尚未开放。</p>

        <form v-else class="form" novalidate @submit.prevent="onRegister">
          <div class="field">
            <label for="register-email">邮箱</label>
            <input id="register-email" v-model="email" type="email" autocomplete="email" required />
          </div>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <p v-if="notice" class="notice" role="status">{{ notice }}</p>
          <button type="submit" class="submit" :disabled="busy">发送验证邮件</button>
        </form>
      </div>
    </template>
  </main>
</template>

<style scoped>
.login {
  width: 100%;
  max-width: 420px;
  margin: 0 auto;
  padding: var(--space-48) var(--space-16);
}
h1 {
  margin-bottom: var(--space-24);
  font-family: var(--font-title);
  font-weight: 400;
}
.tabs {
  display: flex;
  gap: var(--space-24);
  margin-bottom: var(--space-24);
  border-bottom: 1px solid var(--line);
}
.tab {
  min-height: 44px;
  min-width: 44px;
  padding: 0;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
}
.tab[aria-selected='true'] {
  border-bottom-color: var(--accent);
  color: var(--fg);
}
.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-16);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
label {
  color: var(--fg-muted);
}
.pw {
  display: flex;
}
input {
  flex: 1;
  min-width: 0;
  min-height: 44px;
  padding: 0 var(--space-12);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
}
.toggle,
.submit {
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  cursor: pointer;
}
.toggle {
  border-left: 0;
  color: var(--fg-muted);
}
.submit {
  align-self: flex-start;
  border-color: var(--accent);
}
.submit:disabled {
  cursor: progress;
  opacity: 0.6;
}
.tab:focus-visible,
.toggle:focus-visible,
.submit:focus-visible,
input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.hint,
.closed,
.notice {
  color: var(--fg-muted);
}
.error {
  color: var(--fg);
}
</style>
