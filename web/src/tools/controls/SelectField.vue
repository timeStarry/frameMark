<script setup lang="ts">
import { useId } from 'vue'

defineProps<{ label: string; modelValue: string; options: { value: string; label: string }[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: string] }>()
const uid = useId()
function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLSelectElement).value)
}
</script>

<template>
  <div class="field">
    <label :for="`${uid}-s`">{{ label }}</label>
    <select :id="`${uid}-s`" :value="modelValue" :disabled="disabled" @change="onChange">
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
  </div>
</template>

<style scoped>
.field { display: flex; align-items: center; gap: var(--space-12); min-height: 44px; }
label { color: var(--fg-muted); flex: 1; }
select { min-height: 44px; padding: 0 var(--space-8); border: 1px solid var(--line); background: var(--bg-wall); color: var(--fg); font: inherit; }
select:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
</style>
