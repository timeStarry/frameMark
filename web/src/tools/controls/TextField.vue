<script setup lang="ts">
import { useId } from 'vue'

const props = defineProps<{ label: string; modelValue: string; rows?: number; disabled?: boolean; maxLength?: number; counter?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: string] }>()
const uid = useId()
const MAX = props.maxLength ?? 200
function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <div class="field">
    <label :for="`${uid}-t`">{{ label }}</label>
    <textarea
      :id="`${uid}-t`"
      :rows="rows ?? 3"
      :value="modelValue"
      :disabled="disabled"
      :aria-describedby="counter ? `${uid}-c` : undefined"
      @input="onInput"
    />
    <p v-if="counter" :id="`${uid}-c`" class="count" role="status">{{ [...modelValue].length }} / {{ MAX }}</p>
  </div>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: var(--space-8); }
label { color: var(--fg-muted); }
textarea { min-height: 44px; padding: var(--space-8); border: 1px solid var(--line); background: var(--bg-wall); color: var(--fg); font: inherit; resize: vertical; border-radius: 0; }
textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.count { margin: 0; font-family: var(--font-mono); color: var(--fg-muted); text-align: right; }
</style>
