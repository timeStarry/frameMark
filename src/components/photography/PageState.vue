<script setup>
defineProps({ kind: { type: String, default: 'empty' }, message: { type: String, required: true } })
defineEmits(['retry'])
</script>

<template>
  <div class="page-state" :class="`page-state--${kind}`" :role="kind === 'error' ? 'alert' : 'status'">
    <p>{{ message }}</p>
    <button v-if="kind === 'error'" type="button" @click="$emit('retry')">重试</button>
  </div>
</template>

<style scoped>
.page-state { min-height: 180px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 16px; color: var(--markr-muted); font-size: 14px; line-height: 1.8; }
.page-state--error { color: var(--markr-error); }
.page-state button { min-height: 44px; padding: 8px 18px; color: var(--markr-text); border: 1px solid var(--markr-line-strong); border-radius: 6px; background: transparent; cursor: pointer; }
</style>
