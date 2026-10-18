<script setup lang="ts">
// 主页资料 (SP4a spec §8): name, bio, wall layout, saved by PUT /api/profile.
// Values come from GET /api/u/{me}. Limits mirror internal/api/profile.go.
// Emits `dirty` whenever the draft differs from the last loaded or saved value.
import { computed, onBeforeUnmount, reactive, ref, useId, watch } from 'vue'
import { getUser } from '../api/client'
import { putProfile } from '../api/me'
import { session } from '../api/session'
import type { ProfileInput } from '../api/types'
import WallStatus from '../walls/WallStatus.vue'

const emit = defineEmits<{ dirty: [boolean] }>()

const MAX_NAME = 60
const MAX_BIO = 500
const NAME_MESSAGE = '名字需为 1–60 个字符。'
const BIO_MESSAGE = '简介不能超过 500 个字符。'

const id = useId()
const headingId = `${id}-title`

const draft = reactive<ProfileInput>({ name: '', bio: '', wallLayout: 'salon' })
const state = ref<'loading' | 'error' | 'idle'>('loading')
const baseline = ref<string | null>(null)
const payload = (): ProfileInput => ({ name: draft.name, bio: draft.bio, wallLayout: draft.wallLayout })
const current = computed(() => JSON.stringify(payload()))
const dirty = computed(() => baseline.value !== null && current.value !== baseline.value)
const busy = ref(false)
const saved = ref(false)
const error = ref('')

watch(dirty, (v) => emit('dirty', v), { immediate: true })
// Only a real edit clears 已保存; adopting the server's reply does not.
watch(current, () => {
  if (dirty.value) saved.value = false
})

const runes = (s: string) => [...s].length

function adopt(p: ProfileInput): void {
  draft.name = p.name
  draft.bio = p.bio
  draft.wallLayout = p.wallLayout
  baseline.value = JSON.stringify(payload())
}

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
    const { name, bio, wallLayout } = r.data.profile
    adopt({ name, bio, wallLayout })
    state.value = 'idle'
    return
  }
  if (r.status === -1) return
  state.value = 'error'
}

interface ProfileReply {
  name?: unknown
  bio?: unknown
  wallLayout?: unknown
}

async function onSubmit(): Promise<void> {
  if (busy.value || !dirty.value) return
  error.value = ''
  const p = payload()
  // The server trims; validate the trimmed length so the message matches.
  const n = runes(p.name.trim())
  if (n < 1 || n > MAX_NAME) {
    error.value = NAME_MESSAGE
    return
  }
  if (runes(p.bio.trim()) > MAX_BIO) {
    error.value = BIO_MESSAGE
    return
  }
  const me = session.user
  busy.value = true
  const r = await putProfile(p)
  busy.value = false
  if (!r.ok) {
    if (r.status !== -1) error.value = r.message
    return
  }
  // Prefer the server's cleaned values; fall back to what was sent.
  const d = (r.data ?? {}) as ProfileReply
  adopt({
    name: typeof d.name === 'string' ? d.name : p.name,
    bio: typeof d.bio === 'string' ? d.bio : p.bio,
    wallLayout: d.wallLayout === 'salon' || d.wallLayout === 'grid' ? d.wallLayout : p.wallLayout,
  })
  saved.value = true
  try {
    sessionStorage.removeItem('markr:wallCache:user:' + me)
  } catch {
    // Storage blocked: nothing was cached either.
  }
}

watch(() => session.user, () => void load(), { immediate: true })
onBeforeUnmount(() => {
  ctrl?.abort()
  ctrl = null
})
</script>

<template>
  <form class="settings-form" :aria-labelledby="headingId" novalidate @submit.prevent="onSubmit">
    <h2 :id="headingId">主页资料</h2>
    <template v-if="state === 'idle'">
      <div class="field">
        <label :for="`${id}-name`">名字</label>
        <input
          :id="`${id}-name`"
          v-model="draft.name"
          name="name"
          type="text"
          required
          autocomplete="nickname"
          :aria-describedby="`${id}-name-hint`"
        />
        <span :id="`${id}-name-hint`" class="hint">1–60 个字符</span>
      </div>
      <div class="field">
        <label :for="`${id}-bio`">简介</label>
        <textarea :id="`${id}-bio`" v-model="draft.bio" name="bio" rows="3" :aria-describedby="`${id}-bio-hint`" />
        <span :id="`${id}-bio-hint`" class="hint">最多 500 个字符</span>
      </div>
      <fieldset>
        <legend>主页布局</legend>
        <div class="radios">
          <label class="check">
            <input v-model="draft.wallLayout" type="radio" :name="`${id}-layout`" value="salon" />
            错列
          </label>
          <label class="check">
            <input v-model="draft.wallLayout" type="radio" :name="`${id}-layout`" value="grid" />
            均匀网格
          </label>
        </div>
      </fieldset>
      <div class="actions">
        <button type="submit" :disabled="!dirty || busy" :aria-busy="busy ? 'true' : undefined">保存</button>
        <p class="status" role="status">{{ saved ? '已保存' : '' }}</p>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </template>
    <WallStatus v-else :state="state" @retry="load" />
  </form>
</template>

<style scoped src="./settingsForm.css"></style>
