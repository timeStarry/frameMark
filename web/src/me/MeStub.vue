<script setup lang="ts">
// Temporary /me child page; tasks 5, 7 and 8 replace it.
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const title = computed(() => String(route.meta.title ?? ''))
</script>

<template>
  <main class="me-page" aria-labelledby="me-page-title">
    <h1 id="me-page-title">{{ title }}</h1>
  </main>
</template>

<style scoped>
.me-page {
  padding: var(--space-32) var(--space-16);
}
h1 {
  font-family: var(--font-title);
  font-weight: 400;
}
</style>
