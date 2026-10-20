<script setup lang="ts">
// One photo's properties in the desk panel (spec §4.4): title and caption
// (always editable) plus this collection's exposure override. The exposure
// controls lock while a check is pending, since they can widen what is public.
import { computed, useId } from 'vue'
import { FIELD_LABEL } from './labels'
import type { Desk } from './useDesk'

const props = defineProps<{ desk: Desk; photoId: string; locked: boolean }>()

const uid = useId()
const FIELDS = Object.keys(FIELD_LABEL)
const p = computed(
  () => props.desk.photoProps.value[props.photoId] ?? { title: '', caption: '', publicFields: [], histogramPublic: false, overridden: false },
)

function setTitle(e: Event) {
  props.desk.setPhotoMeta(props.photoId, { title: (e.target as HTMLInputElement).value, caption: p.value.caption })
}
function setCaption(e: Event) {
  props.desk.setPhotoMeta(props.photoId, { title: p.value.title, caption: (e.target as HTMLTextAreaElement).value })
}
function toggleField(key: string, e: Event) {
  const on = (e.target as HTMLInputElement).checked
  const cur = new Set(p.value.publicFields)
  if (on) cur.add(key)
  else cur.delete(key)
  props.desk.setOverride(props.photoId, { publicFields: FIELDS.filter((k) => cur.has(k)), histogramPublic: p.value.histogramPublic })
}
function toggleHistogram(e: Event) {
  const publicFields = FIELDS.filter((k) => p.value.publicFields.includes(k))
  props.desk.setOverride(props.photoId, { publicFields, histogramPublic: (e.target as HTMLInputElement).checked })
}
</script>

<template>
  <div class="photo-props">
    <label :for="`${uid}-title`">标题</label>
    <input :id="`${uid}-title`" type="text" :value="p.title" @input="setTitle" />
    <label :for="`${uid}-caption`">说明</label>
    <textarea :id="`${uid}-caption`" rows="3" :value="p.caption" @input="setCaption" />

    <fieldset>
      <legend>公开的拍摄信息</legend>
      <div class="checks">
        <label v-for="k in FIELDS" :key="k" class="check">
          <input type="checkbox" :checked="p.publicFields.includes(k)" :disabled="locked" @change="toggleField(k, $event)" />
          {{ FIELD_LABEL[k] }}
        </label>
        <label class="check">
          <input type="checkbox" :checked="p.histogramPublic" :disabled="locked" @change="toggleHistogram" />
          直方图公开
        </label>
      </div>
    </fieldset>
    <button v-if="p.overridden" type="button" :disabled="locked" @click="desk.clearOverride(photoId)">恢复默认</button>
    <p v-if="locked" class="note">正在确认公开范围…</p>
  </div>
</template>

<style scoped>
.photo-props {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
input[type='text'],
textarea {
  min-height: 44px;
  padding: var(--space-8);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg);
  font: inherit;
}
fieldset {
  border: 0;
  padding: 0;
  margin: var(--space-8) 0 0;
}
legend {
  color: var(--fg-muted);
  margin-bottom: var(--space-4);
}
.checks {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.check {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  min-height: 44px;
  cursor: pointer;
}
.check input {
  width: 20px;
  height: 20px;
}
button {
  align-self: flex-start;
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
button:disabled,
.check:has(input:disabled) {
  cursor: default;
  opacity: 0.6;
}
.note {
  color: var(--fg-muted);
}
input:focus-visible,
textarea:focus-visible,
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
