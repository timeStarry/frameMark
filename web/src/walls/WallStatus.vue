<script setup lang="ts">
// Loading / error line under a wall (spec §4.3, §8). Idle renders nothing.
defineProps<{ state: 'loading' | 'error' | 'idle' }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <p v-if="state === 'loading'" class="wall-status" role="status">载入中</p>
  <div v-else-if="state === 'error'" class="wall-status">
    <p>网络连接出了问题</p>
    <button type="button" @click="$emit('retry')">重试</button>
  </div>
</template>

<style scoped>
.wall-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-12);
  padding: var(--space-32) var(--space-16);
  color: var(--fg-muted);
  text-align: center;
}
p {
  margin: 0;
}
button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
</style>
