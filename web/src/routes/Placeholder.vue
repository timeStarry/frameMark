<script setup lang="ts">
// Stub for routes that are not built yet.
import { RouterLink } from 'vue-router'
import WallNav from '../walls/WallNav.vue'
</script>

<template>
  <WallNav />
  <main class="placeholder">
    <h1>这里还在建设中</h1>
    <p><RouterLink to="/">回到广场</RouterLink></p>
  </main>
</template>

<style scoped>
.placeholder {
  padding: var(--space-48) max(16px, 4vw);
  background: var(--bg-wall);
  min-height: 60vh;
}
h1 {
  font-family: var(--font-title);
  font-weight: 400;
  margin-bottom: var(--space-12);
}
a {
  color: var(--accent);
}
</style>
