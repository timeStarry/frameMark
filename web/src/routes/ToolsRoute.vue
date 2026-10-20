<script setup lang="ts">
// /tools (spec §2.3): entry page for the frame and collage tools.
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import WallNav from '../walls/WallNav.vue'
import { usePageHeading } from '../me/pageHeading'

const heading = ref<HTMLElement | null>(null)
usePageHeading(heading, () => '工具')
</script>

<template>
  <div class="tools-page">
    <WallNav />
    <main aria-labelledby="tools-title">
      <h1 id="tools-title" ref="heading" tabindex="-1">工具</h1>
      <p class="note">照片只在你的浏览器里处理，不上传。</p>
      <nav class="entries" aria-label="工具列表">
        <RouterLink to="/tools/frame" class="entry">
          <strong>边框</strong>
          <span>给照片加上边框、题签和拍摄参数</span>
        </RouterLink>
        <RouterLink to="/tools/collage" class="entry">
          <strong>拼图</strong>
          <span>把 2–12 张照片拼成一张</span>
        </RouterLink>
      </nav>
    </main>
  </div>
</template>

<style scoped>
.tools-page { min-height: 100vh; background: var(--bg-wall); }
main { max-width: 640px; margin: 0 auto; padding: var(--space-24) max(16px, 4vw); }
h1 { font-family: var(--font-title); font-weight: 400; font-size: 1.5rem; margin: 0 0 var(--space-8); }
h1:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.note { color: var(--fg-muted); margin: 0 0 var(--space-24); }
.entries { display: flex; flex-direction: column; gap: var(--space-16); }
.entry { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-16); border: 1px solid var(--line); color: var(--fg); text-decoration: none; min-height: 44px; }
.entry:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.entry strong { font-size: 1.125rem; }
.entry span { color: var(--fg-muted); }
</style>
