<template>
  <div id="app">
    <Header />
    <main id="main-content" class="app-main" tabindex="-1">
      <router-view />
    </main>
    <Footer v-if="!$route.path.startsWith('/work/')" />
  </div>
</template>

<script setup>
import Header from '@/components/layout/Header.vue'
import Footer from '@/components/layout/Footer.vue'
</script>

<style scoped>
#app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #090a0c;
}

.app-main {
  flex: 1;
}
</style> 