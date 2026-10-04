<script setup lang="ts">
import { ref, watch } from 'vue';
const props = defineProps<{
    label: string;
    modelValue: number;
    min: number;
    max: number;
    step?: number;
    unit?: string;
}>(), emit = defineEmits<{
    'update:modelValue': [
        value: number
    ];
    commit: [
    ];
    start: [
    ];
}>(), draft = ref(String(props.modelValue)), error = ref('');
watch(() => props.modelValue, value => { draft.value = String(value); });
function valid(n:number){const step=props.step||1;return Number.isFinite(n)&&n>=props.min&&n<=props.max&&Math.abs((n-props.min)/step-Math.round((n-props.min)/step))<1e-7}
function numberInput(event: Event) { draft.value = (event.target as HTMLInputElement).value; const n = Number(draft.value); if (draft.value !== '' && valid(n)) {
    error.value = '';
    emit('update:modelValue', n);
} }
function finish() { const n = Number(draft.value); if (draft.value === '' || !valid(n)) {
    error.value = `请输入 ${props.min}–${props.max} 且步长为 ${props.step||1} 的数值`;
    draft.value = String(props.modelValue);
    return;
} emit('commit'); }
function rangeInput(event: Event) { error.value = ''; emit('update:modelValue', (event.target as HTMLInputElement).valueAsNumber); }
</script>
<template>
<label class="number-control">
<span>{{label}} <small>{{unit}}</small>
</span>
<div>
<input type="range" :aria-label="label" :value="modelValue" :min="min" :max="max" :step="step||1" :style="{'--range-track':`linear-gradient(to right,var(--markr-accent) 0%,var(--markr-accent) ${(modelValue-min)/(max-min)*100}%,var(--markr-line-strong) ${(modelValue-min)/(max-min)*100}%,var(--markr-line-strong) 100%)`}" @pointerdown="emit('start')" @input="rangeInput" @change="emit('commit')">
<input type="number" :aria-label="label+'数值'" :aria-invalid="!!error" :value="draft" :min="min" :max="max" :step="step||1" @focus="emit('start')" @input="numberInput" @change="finish">
</div>
<small v-if="error" role="alert">{{error}}</small>
</label>
</template>
