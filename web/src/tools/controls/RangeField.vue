<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{ label: string; modelValue: number; min: number; max: number; step: number; disabled?: boolean; suffix?: string }>()
const emit = defineEmits<{ 'update:modelValue': [v: number] }>()
const uid = useId()
const shown = computed(() => `${props.modelValue}${props.suffix ?? ''}`)
function onInput(e: Event) {
  emit('update:modelValue', Number((e.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="field" :class="{ disabled }">
    <label :for="`${uid}-r`">{{ label }}</label>
    <input :id="`${uid}-r`" type="range" :min="min" :max="max" :step="step" :value="modelValue" :disabled="disabled" @input="onInput" />
    <output :for="`${uid}-r`">{{ shown }}</output>
  </div>
</template>

<style scoped>
.field { display: grid; grid-template-columns: minmax(80px, 1fr) 3fr minmax(48px, auto); align-items: center; gap: var(--space-12); min-height: 44px; }
label { color: var(--fg-muted); }
input[type='range'] { width: 100%; min-height: 44px; }
output { font-family: var(--font-mono); color: var(--fg); text-align: right; }
.disabled { opacity: 0.45; }
</style>
