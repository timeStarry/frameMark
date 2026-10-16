<script setup lang="ts">
// Placeholder; replaced by the real viewer route in Task 7.
defineProps<{ id: string }>()
</script>

<template>
  <main class="collection">
    <p>正在打开作品集……</p>
  </main>
</template>

<style scoped>
.collection {
  min-height: 100vh;
  background: var(--bg-view);
  padding: var(--space-24);
  color: var(--fg-muted);
}
</style>
