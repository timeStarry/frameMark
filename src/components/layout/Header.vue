<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
defineProps({ minimal: Boolean })
const route = useRoute()
const toolRoute = computed(() => ['/tools', '/frame-watermark', '/image-collage'].includes(route.path))
</script>

<template>
  <header class="site-header" :class="{ 'viewer-header': minimal }">
    <a class="skip-link" href="#main-content">跳到内容</a>
    <div class="site-header-inner">
      <router-link to="/" class="wordmark" aria-label="Markr 首页">Markr</router-link>
      <template v-if="!minimal">
        <nav aria-label="主要导航" class="primary-nav">
          <router-link to="/" class="nav-item" :class="{ selected: route.path === '/' }">广场</router-link>
          <router-link to="/tools" class="nav-item" :class="{ selected: toolRoute }">工具箱</router-link>
        </nav>
        <router-link to="/studio" class="studio-link" :class="{ selected: route.path === '/studio' || route.path === '/login' }">我的工作台</router-link>
      </template>
    </div>
  </header>
</template>

<style scoped>
.site-header{position:sticky;top:0;z-index:100;background:var(--markr-bg)}
.site-header-inner{max-width:1600px;margin:auto;padding:0 var(--markr-page-gutter);min-height:72px;display:flex;align-items:center;gap:48px}
.wordmark{display:inline-flex;align-items:center;min-height:44px;color:var(--markr-text);font-size:23px;letter-spacing:-.045em;font-weight:500;text-decoration:none}
.primary-nav{display:flex;gap:24px;align-items:center}
.nav-item,.studio-link{display:inline-flex;align-items:center;min-height:44px;color:var(--markr-muted);font-size:14px;text-decoration:none;transition:color var(--markr-motion-control) var(--markr-ease-control);white-space:nowrap}
.nav-item:hover,.nav-item.selected,.studio-link:hover,.studio-link.selected{color:var(--markr-text)}
.studio-link{margin-left:auto}
.viewer-header{position:relative}
.viewer-header .site-header-inner{min-height:56px}
.viewer-header .wordmark{font-size:20px;color:var(--markr-muted)}
.skip-link{position:absolute;left:16px;top:-80px;padding:12px 16px;background:var(--markr-accent);color:var(--markr-bg);z-index:1}
.skip-link:focus{top:8px}
@media(max-width:600px){.site-header-inner{min-height:64px;gap:24px}.primary-nav{gap:16px}.wordmark{font-size:21px}.nav-item,.studio-link{font-size:13px}}
@media(max-width:370px){.site-header-inner{gap:18px}.primary-nav{gap:12px}.studio-link{font-size:12px}}
</style>
