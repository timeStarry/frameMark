<script setup lang="ts">
// Collection settings in the desk panel (spec §4.4, §4.5): title, intro,
// cover, visibility, square, license, AI declaration and original download,
// then 删除合集 behind a typed-title confirmation. Text edits are 'field'
// (debounced); every toggle or select is 'exposure' and locks while a check is
// pending.
import { computed, ref, useId } from 'vue'
import type { CollectionFields, Visibility } from '../api/types'
import ConfirmDialog from '../me/ConfirmDialog.vue'
import { LICENSE_LABEL } from './labels'
import { cleanText } from './sequence'
import type { Desk } from './useDesk'

const props = defineProps<{ desk: Desk; locked: boolean }>()
const emit = defineEmits<{ deleted: [] }>()

const uid = useId()
const VISIBILITIES: { value: Visibility; label: string }[] = [
  { value: 'private', label: '私密' },
  { value: 'unlisted', label: '仅链接' },
  { value: 'public', label: '公开' },
]
const LICENSES = Object.keys(LICENSE_LABEL)
const AI = [{ value: 'no-generative-ai', label: '未使用生成式 AI' }]

const f = computed(() => props.desk.fields.value)
/** Distinct photos in the sequence with media, i.e. ready to be a cover. */
const coverOptions = computed(() => {
  const seen = new Map<string, string>()
  for (const fr of props.desk.seq.value) for (const p of fr.photos) if (p.media && !seen.has(p.id)) seen.set(p.id, p.title.trim() || '无标题')
  return [...seen].map(([id, title]) => ({ id, title }))
})

function set(patch: Partial<CollectionFields>, kind: 'field' | 'exposure') {
  props.desk.applyFields({ ...f.value, ...patch }, kind)
}
const val = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value
const checked = (e: Event) => (e.target as HTMLInputElement).checked
const orNull = (s: string) => (s === '' ? null : s)

function onVisibility(v: Visibility) {
  // Only a public collection can be in the square.
  set(v === 'public' ? { visibility: v } : { visibility: v, distribute: false }, 'exposure')
}

const deleting = ref(false)
const typed = ref('')
const busy = ref(false)
const deleteError = ref('')
// The confirmation word is the title, or 删除 when the title is empty, so an
// empty box can never confirm.
const confirmWord = computed(() => cleanText(f.value.title) || '删除')
const canDelete = computed(() => cleanText(typed.value) === confirmWord.value)

function openDelete() {
  typed.value = ''
  deleteError.value = ''
  deleting.value = true
}
function cancelDelete() {
  if (!busy.value) deleting.value = false
}
async function confirmDelete() {
  if (!canDelete.value || busy.value) return
  busy.value = true
  deleteError.value = ''
  const ok = await props.desk.remove()
  busy.value = false
  if (ok) {
    deleting.value = false
    emit('deleted')
  } else deleteError.value = props.desk.errorMessage.value || '删除失败，请重试'
}
</script>

<template>
  <div class="collection-props">
    <label :for="`${uid}-title`">标题</label>
    <input :id="`${uid}-title`" type="text" :value="f.title" @input="set({ title: val($event) }, 'field')" />
    <label :for="`${uid}-intro`">简介</label>
    <textarea :id="`${uid}-intro`" rows="4" :value="f.intro" @input="set({ intro: val($event) }, 'field')" />

    <label :for="`${uid}-cover`">封面</label>
    <select :id="`${uid}-cover`" :value="f.coverPhotoId ?? ''" :disabled="locked" @change="set({ coverPhotoId: orNull(val($event)) }, 'exposure')">
      <option value="">自动（第一张）</option>
      <option v-for="o in coverOptions" :key="o.id" :value="o.id">{{ o.title }}</option>
    </select>

    <fieldset>
      <legend>可见性</legend>
      <label v-for="v in VISIBILITIES" :key="v.value" class="check">
        <input
          type="radio"
          :name="`${uid}-vis`"
          :value="v.value"
          :checked="f.visibility === v.value"
          :disabled="locked"
          @change="onVisibility(v.value)"
        />
        {{ v.label }}
      </label>
    </fieldset>
    <p v-if="f.visibility === 'unlisted'" class="note">知道链接的人都能看，并不是安全的访问控制</p>

    <label class="check">
      <input
        type="checkbox"
        :checked="f.distribute"
        :disabled="locked || f.visibility !== 'public'"
        @change="set({ distribute: checked($event) }, 'exposure')"
      />
      进入广场
    </label>

    <label :for="`${uid}-license`">许可</label>
    <select :id="`${uid}-license`" :value="f.license ?? ''" :disabled="locked" @change="set({ license: orNull(val($event)) }, 'exposure')">
      <option value="">无</option>
      <option v-for="l in LICENSES" :key="l" :value="l">{{ LICENSE_LABEL[l] }}</option>
    </select>

    <label :for="`${uid}-ai`">AI 声明</label>
    <select :id="`${uid}-ai`" :value="f.aiDeclaration ?? ''" :disabled="locked" @change="set({ aiDeclaration: orNull(val($event)) }, 'exposure')">
      <option value="">无</option>
      <option v-for="a in AI" :key="a.value" :value="a.value">{{ a.label }}</option>
    </select>

    <label class="check">
      <input type="checkbox" :checked="f.originalDownload" :disabled="locked" @change="set({ originalDownload: checked($event) }, 'exposure')" />
      允许下载原图
    </label>

    <div class="danger-zone">
      <button type="button" class="danger" :disabled="locked" @click="openDelete">删除合集</button>
    </div>

    <ConfirmDialog
      title="删除合集"
      body="删除后无法恢复，合集的链接也会失效。照片仍保留在作品库。"
      confirm-label="删除"
      :open="deleting"
      :busy="busy"
      :confirm-disabled="!canDelete"
      :error="deleteError"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    >
      <div class="typed">
        <label :for="`${uid}-typed`">{{ cleanText(f.title) ? `输入合集标题「${f.title}」以确认` : '输入「删除」以确认' }}</label>
        <input :id="`${uid}-typed`" v-model="typed" type="text" autocomplete="off" />
      </div>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.collection-props {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
input[type='text'],
textarea,
select {
  min-height: 44px;
  padding: var(--space-8);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
}
fieldset {
  border: 0;
  padding: 0;
  margin: var(--space-8) 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--space-16);
}
legend {
  color: var(--fg-muted);
  margin-bottom: var(--space-4);
}
.check {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  min-height: 44px;
  cursor: pointer;
}
.check:has(input:disabled),
select:disabled,
button:disabled {
  cursor: default;
  opacity: 0.6;
}
.note {
  color: var(--fg-muted);
}
.danger-zone {
  margin-top: var(--space-24);
  padding-top: var(--space-16);
  border-top: 1px solid var(--line);
}
button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
button.danger {
  border-color: var(--fg);
}
.typed {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  margin-top: var(--space-12);
}
input:focus-visible,
textarea:focus-visible,
select:focus-visible,
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
