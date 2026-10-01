<script setup lang="ts">
import { ref, watch } from 'vue';
const props = defineProps<{
    label: string;
    modelValue: string;
}>(), emit = defineEmits<{
    'update:modelValue': [
        value: string
    ];
    commit: [
    ];
}>(), draft = ref(props.modelValue), error = ref('');
watch(() => props.modelValue, v => draft.value = v);
function change() { if (!/^#[0-9a-f]{6}$/i.test(draft.value)) {
    error.value = '请输入六位 HEX，如 #f3f1ea';
    draft.value = props.modelValue;
    return;
} error.value = ''; emit('update:modelValue', draft.value); emit('commit'); }
</script>
<template>
<label class="color-control">
<span>{{label}}</span>
<div>
<input type="color" :aria-label="label" :value="modelValue" @input="emit('update:modelValue',($event.target as HTMLInputElement).value)" @change="emit('commit')">
<input v-model="draft" :aria-label="label+' HEX'" :aria-invalid="!!error" maxlength="7" @change="change">
</div>
<small v-if="error" role="alert">{{error}}</small>
</label>
</template>
