<script setup lang="ts">
// Saves a tool export to the archive (spec §4).
import { ref, computed } from 'vue'
import { session } from '../api/session'
import { createUpload, completeUpload, getPhoto } from '../api/me'
import { sha256Hex } from '../me/sha256'
import type { OwnerPhoto } from '../api/types'

const props = defineProps<{
  blob: Blob
  defaultTitle: string
  sourceIds: string[]
}>()
const emit = defineEmits<{ done: [photo: OwnerPhoto]; close: [] }>()

const title = ref(props.defaultTitle)
const busy = ref(false)
const error = ref('')
const done = ref(false)

const canSave = computed(() => !busy.value && !done.value)

async function save() {
  busy.value = true
  error.value = ''
  try {
    const file = new File([props.blob], `${title.value || 'markr-tool'}.${ext()}`, { type: props.blob.type })
    const hash = await sha256Hex(file)
    const r = await createUpload({
      filename: file.name,
      bytes: file.size,
      sha256: hash,
      contentType: file.type,
      title: title.value,
      derivedFrom: props.sourceIds,
      toolOutput: true,
    })
    if (!r.ok) { error.value = r.message; return }
    if (r.status === 200) {
      // Duplicate: already in the archive.
      done.value = true
      emit('done', r.data as OwnerPhoto)
      return
    }
    const init = r.data as { photoId: string; upload: { url: string; method: string; headers: Record<string, string> } }
    // Direct PUT to S3.
    const xhr = new XMLHttpRequest()
    await new Promise<void>((resolve, reject) => {
      xhr.open(init.upload.method, init.upload.url)
      xhr.withCredentials = false
      for (const [k, v] of Object.entries(init.upload.headers)) xhr.setRequestHeader(k, v)
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('上传失败')))
      xhr.onerror = () => reject(new Error('上传失败'))
      xhr.send(file)
    })
    const comp = await completeUpload(init.photoId)
    if (!comp.ok) { error.value = comp.message; return }
    // Poll until ready.
    let photo = comp.data
    for (let i = 0; i < 60 && photo.status !== 'ready' && photo.status !== 'failed'; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const g = await getPhoto(init.photoId)
      if (g.ok) photo = g.data
    }
    done.value = true
    emit('done', photo)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = false
  }
}

function ext() {
  return props.blob.type === 'image/png' ? 'png' : props.blob.type === 'image/webp' ? 'webp' : 'jpg'
}
</script>

<template>
  <div v-if="session.user" class="save-dialog" role="dialog" aria-label="存入归档">
    <h2>存入归档</h2>
    <label class="field">
      标题
      <input v-model="title" type="text" maxlength="120" :disabled="busy || done" />
    </label>
    <p class="note">公开字段沿用你的上传偏好；下载水印不会再叠加到这张图上。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="done" class="done" role="status">
      已存入归档。
      <RouterLink to="/me">去归档查看</RouterLink>
    </p>
    <div class="actions">
      <button type="button" :disabled="!canSave" @click="save">
        {{ busy ? '保存中…' : '存入' }}
      </button>
      <button type="button" @click="emit('close')">关闭</button>
    </div>
  </div>
</template>

<style scoped>
.save-dialog { display: flex; flex-direction: column; gap: var(--space-12); padding: var(--space-16); border: 1px solid var(--line); background: var(--bg-wall); }
h2 { margin: 0; font-family: var(--font-title); font-weight: 400; font-size: 1rem; }
.field { display: flex; flex-direction: column; gap: var(--space-4); color: var(--fg-muted); }
input { min-height: 44px; padding: 0 var(--space-8); border: 1px solid var(--line); background: var(--bg-wall); color: var(--fg); font: inherit; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.note { margin: 0; color: var(--fg-muted); font-size: 0.875rem; }
.error { margin: 0; color: var(--fg); }
.done { margin: 0; color: var(--fg); }
.done a { color: var(--accent); }
.actions { display: flex; gap: var(--space-8); }
button { min-height: 44px; padding: 0 var(--space-16); border: 1px solid var(--line); background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
button:disabled { opacity: 0.45; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
</style>
