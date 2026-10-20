<script setup lang="ts">
import { useId } from 'vue'

defineProps<{ label: string; modelValue: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: string] }>()
const uid = useId()
function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="field">
    <label :for="`${uid}-c`">{{ label }}</label>
    <input :id="`${uid}-c`" type="color" :value="modelValue" :disabled="disabled" @input="onInput" />
  </div>
</template>

<style scoped>
.field { display: flex; align-items: center; gap: var(--space-12); min-height: 44px; }
label { color: var(--fg-muted); flex: 1; }
input { width: 44px; height: 44px; padding: 0; border: 1px solid var(--line); background: none; cursor: pointer; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
</style>
