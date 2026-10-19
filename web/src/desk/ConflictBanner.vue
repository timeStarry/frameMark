<script setup lang="ts">
// An inline alert above the desk (not a modal): a save conflict, or a local
// backup left by an unsaved session.
defineProps<{ kind: 'conflict' | 'backup' }>()
const emit = defineEmits<{ reload: []; overwrite: []; restore: []; discard: [] }>()
</script>

<template>
  <div class="banner" role="alert" :data-kind="kind">
    <template v-if="kind === 'conflict'">
      <p>这个合集在别处被修改过</p>
      <div class="actions">
        <button type="button" @click="emit('reload')">载入最新版本</button>
        <button type="button" @click="emit('overwrite')">用我的版本覆盖</button>
      </div>
    </template>
    <template v-else>
      <p>有一份未保存的修改，要恢复吗？</p>
      <div class="actions">
        <button type="button" @click="emit('restore')">恢复</button>
        <button type="button" @click="emit('discard')">丢弃</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-12);
  padding: var(--space-12) var(--space-16);
  border: 1px solid var(--fg);
  background: var(--bg-wall);
  color: var(--fg);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-12);
}
button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
