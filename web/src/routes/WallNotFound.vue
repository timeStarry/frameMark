<script setup lang="ts">
// Full-page 404 for wall routes (spec §8).
import { RouterLink } from 'vue-router'
import WallNav from '../walls/WallNav.vue'

defineProps<{ message: string }>()
// The wall route resets the title to `Markr` when it unmounts.
document.title = '未找到 — Markr'
</script>

<template>
  <WallNav />
  <main class="wall-missing" aria-labelledby="wall-missing-title">
    <h1 id="wall-missing-title" class="msg">{{ message }}</h1>
    <RouterLink to="/">回首页</RouterLink>
  </main>
</template>

<style scoped>
.wall-missing {
  /* Fill the viewport below the 44px WallNav. */
  min-height: calc(100vh - 45px);
  min-height: calc(100dvh - 45px);
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
  font-weight: 400;
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
