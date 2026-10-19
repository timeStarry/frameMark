<script setup lang="ts">
// One frame's properties in the desk panel (spec §4.4): layout, matte ratio,
// text and splitting a pair. Every edit is a structural applySeq.
import { computed, useId } from 'vue'
import type { FrameLayout } from '../api/types'
import { LAYOUT_LABEL } from './labels'
import { MATTE_DEFAULT, MATTE_MAX, MATTE_MIN, MAX_TEXT, allowedLayouts, cleanText, setLayout, setMatte, setText, split } from './sequence'
import type { Desk } from './useDesk'

const props = defineProps<{ desk: Desk; index: number; locked: boolean }>()

const uid = useId()
const LAYOUTS: FrameLayout[] = ['full', 'matted', 'pair', 'text']
const frame = computed(() => props.desk.seq.value[props.index] ?? null)
const allowed = computed(() => (frame.value ? allowedLayouts(frame.value) : []))
const ratio = computed(() => frame.value?.matteRatio ?? MATTE_DEFAULT)
const textLen = computed(() => [...cleanText(frame.value?.text ?? '')].length)

const apply = (next: ReturnType<typeof setLayout>) => props.desk.applySeq(next, 'structure')
const onLayout = (l: FrameLayout) => apply(setLayout(props.desk.seq.value, props.index, l))
const onMatte = (e: Event) => apply(setMatte(props.desk.seq.value, props.index, Number((e.target as HTMLInputElement).value)))
const onText = (e: Event) => apply(setText(props.desk.seq.value, props.index, (e.target as HTMLTextAreaElement).value))
const onSplit = () => apply(split(props.desk.seq.value, props.index))
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
        @input="onMatte"
      />
      <output :for="`${uid}-ratio`">{{ ratio.toFixed(2) }}</output>
    </div>

    <div v-if="frame.layout === 'text'" class="col">
      <label :for="`${uid}-text`">文字</label>
      <textarea :id="`${uid}-text`" rows="6" :value="frame.text ?? ''" :disabled="locked" :aria-describedby="`${uid}-count`" @input="onText" />
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
