<script setup lang="ts">
// One frame's properties in the desk panel (spec §4.4): layout, matte ratio,
// text and splitting a pair. Every edit is a structural applySeq.
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { FrameLayout } from '../api/types'
import { LAYOUT_LABEL } from './labels'
import { MATTE_DEFAULT, MATTE_MAX, MATTE_MIN, MAX_TEXT, allowedLayouts, cleanText, setLayout, setMatte, setText, split } from './sequence'
import type { Desk } from './useDesk'

const props = defineProps<{ desk: Desk; index: number; locked: boolean }>()

const uid = useId()
const LAYOUTS: FrameLayout[] = ['full', 'matted', 'pair', 'text']
const frame = computed(() => props.desk.seq.value[props.index] ?? null)
const allowed = computed(() => (frame.value ? allowedLayouts(frame.value) : []))
const apply = (next: ReturnType<typeof setLayout>) => props.desk.applySeq(next, 'structure')
const onLayout = (l: FrameLayout) => apply(setLayout(props.desk.seq.value, props.index, l))
const onSplit = () => apply(split(props.desk.seq.value, props.index))

// Matte: the output follows the thumb; the edit (one undo step, one save)
// lands when the slider is released.
const ratioDraft = ref<number | null>(null)
const ratio = computed(() => ratioDraft.value ?? frame.value?.matteRatio ?? MATTE_DEFAULT)
const onMatteInput = (e: Event) => {
  ratioDraft.value = Number((e.target as HTMLInputElement).value)
}
const onMatteChange = (e: Event) => {
  ratioDraft.value = null
  apply(setMatte(props.desk.seq.value, props.index, Number((e.target as HTMLInputElement).value)))
}

// Text: typing stays local and commits after a pause or on blur, so a
// sentence is one undo step and one save rather than one per keystroke
// (spec §4.5 field debounce). Text never widens exposure, so it stays
// editable while a check is in flight; useDesk queues the commit.
const TEXT_IDLE_MS = 800
const textDraft = ref<string | null>(null)
const text = computed(() => textDraft.value ?? frame.value?.text ?? '')
const textLen = computed(() => [...cleanText(text.value)].length)
let textTimer: ReturnType<typeof setTimeout> | null = null
// The frame the draft belongs to; a commit always targets it, even if the
// panel has moved on to another frame since.
let draftKey: string | null = null

function commitText() {
  if (textTimer) clearTimeout(textTimer)
  textTimer = null
  const value = textDraft.value
  const key = draftKey
  textDraft.value = null
  draftKey = null
  if (value === null || key === null) return
  const seq = props.desk.seq.value
  const at = seq.findIndex((f) => f.key === key)
  if (at < 0 || seq[at]!.layout !== 'text' || seq[at]!.text === value) return
  apply(setText(seq, at, value))
}

const onTextInput = (e: Event) => {
  if (draftKey === null) draftKey = frame.value?.key ?? null
  textDraft.value = (e.target as HTMLTextAreaElement).value
  if (textTimer) clearTimeout(textTimer)
  textTimer = setTimeout(commitText, TEXT_IDLE_MS)
}

// Switching frames or closing the panel never drops what was typed.
watch(() => frame.value?.key, commitText)

// A reload or tab close inside the idle window (final review M2): commit the
// draft so the desk's backup and unsaved prompt see it, and ask to stay.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (textDraft.value === null) return
  commitText()
  e.preventDefault()
  e.returnValue = ''
}
window.addEventListener('beforeunload', onBeforeUnload)
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  commitText()
})
</script>

<template>
  <div v-if="frame" class="frame-props">
    <fieldset>
      <legend>版式</legend>
      <label v-for="l in LAYOUTS" :key="l" class="radio">
        <input
          type="radio"
          :name="`${uid}-layout`"
          :value="l"
          :checked="frame.layout === l"
          :disabled="locked || !allowed.includes(l)"
          @change="onLayout(l)"
        />
        {{ LAYOUT_LABEL[l] }}
      </label>
    </fieldset>

    <div v-if="frame.layout === 'matted'" class="row">
      <label :for="`${uid}-ratio`">留白比例</label>
      <input
        :id="`${uid}-ratio`"
        type="range"
        :min="MATTE_MIN"
        :max="MATTE_MAX"
        step="0.05"
        :value="ratio"
        :disabled="locked"
        @input="onMatteInput"
        @change="onMatteChange"
      />
      <output :for="`${uid}-ratio`">{{ ratio.toFixed(2) }}</output>
    </div>

    <div v-if="frame.layout === 'text'" class="col">
      <label :for="`${uid}-text`">文字</label>
      <textarea
        :id="`${uid}-text`"
        rows="6"
        :value="text"
        :aria-describedby="`${uid}-count`"
        @input="onTextInput"
        @blur="commitText"
      />
      <p :id="`${uid}-count`" class="count" :class="{ over: textLen > MAX_TEXT }">{{ textLen }} / {{ MAX_TEXT }}</p>
    </div>

    <button v-if="frame.layout === 'pair'" type="button" :disabled="locked" @click="onSplit">拆成单张</button>
  </div>
</template>

<style scoped>
.frame-props {
  display: flex;
  flex-direction: column;
  gap: var(--space-12);
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--space-16);
}
legend {
  color: var(--fg-muted);
  margin-bottom: var(--space-4);
}
.radio {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  min-height: 44px;
  cursor: pointer;
}
.radio:has(input:disabled),
button:disabled {
  cursor: default;
  opacity: 0.6;
}
.row {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  min-height: 44px;
}
.row input {
  flex: 1 1 auto;
  min-height: 44px;
}
output {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.col {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}
textarea {
  padding: var(--space-8);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg);
  font: inherit;
}
.count {
  align-self: flex-end;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
.count.over {
  color: var(--fg);
  font-weight: 600;
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
input:focus-visible,
textarea:focus-visible,
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
