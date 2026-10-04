<template>
  <div id="app">
    <Header :minimal="isViewer" />
    <main id="main-content" class="app-main" tabindex="-1">
      <router-view />
    </main>
    <Footer v-if="!isViewer" />
  </div>
</template>

<script setup>
import { computed, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import Header from '@/components/layout/Header.vue'
import Footer from '@/components/layout/Footer.vue'
const route = useRoute()
const isViewer = computed(() => route.path.startsWith('/work/'))
watch(() => route.path, async path => {
  // Photography pages restore focus once their asynchronous content is ready.
  if (path === '/' || /^\/(work|collection|profile)\//.test(path) || path === '/studio') return
  await nextTick()
  if (route.path !== path) return
  const heading = document.querySelector('#main-content h1')
  if (heading) {
    heading.setAttribute('tabindex', '-1')
    heading.focus({ preventScroll: true })
    document.title = `${heading.textContent.trim()} · Markr`
  } else document.querySelector('#main-content')?.focus({ preventScroll: true })
}, { flush: 'post', immediate: true })
</script>

<style scoped>
#app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--markr-bg);
}

.app-main {
  flex: 1;
  min-width: 0;
}
</style> 