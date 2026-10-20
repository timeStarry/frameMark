<script setup lang="ts">
import { useId } from 'vue'

const POS = ['左上', '上中', '右上', '左中', '正中', '右中', '左下', '下中', '右下']
defineProps<{ label: string; modelValue: number; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: number] }>()
const uid = useId()
</script>

<template>
  <fieldset :aria-label="label">
    <legend>{{ label }}</legend>
    <div class="grid">
      <label v-for="(name, i) in POS" :key="i" :class="{ disabled }">
        <input
          type="radio"
          :name="`${uid}-pos`"
          :value="i"
          :checked="modelValue === i"
          :disabled="disabled"
          @change="emit('update:modelValue', i)"
        />
        {{ name }}
      </label>
    </div>
  </fieldset>
</template>

<style scoped>
fieldset { border: 0; padding: 0; margin: 0; }
legend { color: var(--fg-muted); margin-bottom: var(--space-8); }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-4); }
label { display: flex; align-items: center; gap: var(--space-4); min-height: 44px; cursor: pointer; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.disabled { opacity: 0.45; }
</style>
