<script setup lang="ts">
// Site navigation above every wall (spec §3).
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { session } from '../api/session'

// 我的 leads to the workspace when signed in, otherwise to the login page.
const mine = computed(() => (session.user ? '/me' : '/login'))
</script>

<template>
  <nav class="wall-nav" aria-label="站点">
    <RouterLink to="/" class="brand">Markr</RouterLink>
    <RouterLink to="/tools">工具</RouterLink>
    <RouterLink :to="mine">我的</RouterLink>
  </nav>
</template>

<style scoped>
.wall-nav {
  display: flex;
  align-items: center;
  gap: var(--space-24);
  min-height: 44px;
  padding: 0 var(--space-16);
  border-bottom: 1px solid var(--line);
}
a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: var(--fg-muted);
  text-decoration: none;
}
.brand {
  margin-right: auto;
  color: var(--fg);
  font-family: var(--font-title);
}
a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
</style>
