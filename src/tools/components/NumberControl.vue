<script setup lang="ts">
const props = defineProps<{
    label: string;
    modelValue: number;
    min: number;
    max: number;
    step?: number;
    unit?: string;
}>();
const emit = defineEmits<{
    'update:modelValue': [
        value: number
    ];
    commit: [
    ];
    start: [
    ];
}>();
function update(event: Event) { const input = event.target as HTMLInputElement; if (input.value === '' || !Number.isFinite(input.valueAsNumber))
    return; emit('update:modelValue', Math.min(props.max, Math.max(props.min, input.valueAsNumber))); }
</script>
<template>
<label class="number-control">
<span>{{label}} <small>{{unit}}</small>
</span>
<div>
<input type="range" :aria-label="label" :value="modelValue" :min="min" :max="max" :step="step||1" @pointerdown="emit('start')" @input="update" @change="emit('commit')">
<input type="number" :aria-label="label+'数值'" :value="modelValue" :min="min" :max="max" :step="step||1" @focus="emit('start')" @input="update" @change="emit('commit')">
</div>
</label>
</template>
