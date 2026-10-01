<template>
  <div id="app">
    <Header />
    <main class="main-content">
      <router-view />
    </main>
    <Footer />
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

.main-content {
  flex: 1;
}
</style> 