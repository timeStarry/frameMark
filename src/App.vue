<template>
  <div id="app">
    <Header />
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import Header from '@/components/layout/Header.vue'
</script>

<style scoped>
#app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.main-content {
  flex: 1;
  background: linear-gradient(135deg, #a18875 0%, #8b7968 25%, #796b5e 50%, #6b5d52 75%, #5d5148 100%);
  min-height: calc(100vh - 80px);
}
</style> 