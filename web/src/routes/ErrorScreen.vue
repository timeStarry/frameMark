<script setup lang="ts">
// Full-screen error for the viewer route: missing collection, or a network
// failure with a retry.
defineProps<{ kind: 'missing' | 'network' }>()
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <main class="error" role="alert">
    <p v-if="kind === 'missing'" class="msg">这组照片不存在或已不再公开</p>
    <p v-else class="msg">网络连接出了问题，暂时打不开这组照片</p>
    <p class="actions">
      <button v-if="kind === 'network'" type="button" @click="emit('retry')">重试</button>
      <RouterLink to="/">回首页</RouterLink>
    </p>
  </main>
</template>

<style scoped>
.error {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-24);
  padding: var(--space-24);
  background: var(--bg-view);
  color: var(--fg);
  text-align: center;
}

.msg {
  margin: 0;
  font-family: var(--font-title);
  font-size: 18px;
}

.actions {
  display: flex;
  gap: var(--space-16);
  align-items: center;
  margin: 0;
}

button,
a {
  min-height: 44px;
  padding: var(--space-8) var(--space-16);
  border: 1px solid var(--line);
  border-radius: 4px;
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 14px;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}
</style>
