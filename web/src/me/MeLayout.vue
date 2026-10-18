<script setup lang="ts">
// The /me workspace: site nav, the workspace nav, then the child page (spec §1).
import WallNav from '../walls/WallNav.vue'
import MeNav from './MeNav.vue'
</script>

<template>
  <div class="me-layout">
    <WallNav />
    <MeNav />
    <RouterView />
  </div>
</template>

<style scoped>
.me-layout {
  min-height: 100vh;
  background: var(--bg-wall);
}
</style>
