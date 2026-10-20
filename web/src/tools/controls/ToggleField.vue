<script setup lang="ts">
import { useId } from 'vue'

defineProps<{ label: string; modelValue: boolean; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()
const uid = useId()
function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).checked)
}
</script>

<template>
  <label :for="`${uid}-t`" class="field" :class="{ disabled }">
    <input :id="`${uid}-t`" type="checkbox" :checked="modelValue" :disabled="disabled" @change="onChange" />
    <span>{{ label }}</span>
  </label>
</template>

<style scoped>
.field { display: flex; align-items: center; gap: var(--space-12); min-height: 44px; cursor: pointer; }
input { width: 20px; height: 20px; accent-color: var(--accent); }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.disabled { opacity: 0.45; }
</style>
