<script setup lang="ts">
// Full-page 404 for wall routes (spec §8).
import { RouterLink } from 'vue-router'

defineProps<{ message: string }>()
</script>

<template>
  <main class="wall-missing">
    <p class="msg">{{ message }}</p>
    <RouterLink to="/">回首页</RouterLink>
  </main>
</template>

<style scoped>
.wall-missing {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-24);
  padding: var(--space-24);
  background: var(--bg-wall);
  text-align: center;
}
.msg {
  margin: 0;
  font-family: var(--font-title);
  font-size: 18px;
}
a {
  min-height: 44px;
  padding: var(--space-8) var(--space-16);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
}
a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
</style>
