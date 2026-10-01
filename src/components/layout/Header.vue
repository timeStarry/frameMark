<template>
  <header class="site-header">
    <a class="skip-link" href="#main-content">跳到内容</a>
    <div class="site-header-inner">
      <router-link to="/" class="wordmark" aria-label="Markr 首页"><span class="brand-symbol" aria-hidden="true"></span>Markr<span class="brand-label">摄影 · 创作 · 分享</span></router-link>
      <nav aria-label="主要导航" class="primary-nav">
        <router-link to="/" class="nav-item" :class="{selected:$route.path==='/'}">广场</router-link>
        <router-link to="/tools" class="nav-item" :class="{selected:toolRoute}">工具箱</router-link>
      </nav>
      <router-link to="/studio" class="studio-link" :class="{selected:$route.path==='/studio'||$route.path==='/login'}">我的工作台<span aria-hidden="true"> ↗</span></router-link>
    </div>
  </header>
</template>
<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
const route=useRoute()
const toolRoute=computed(()=>['/tools','/frame-watermark','/image-collage'].includes(route.path))
</script>
<style scoped>
.site-header{position:sticky;top:0;z-index:1000;background:rgba(9,10,11,.94);backdrop-filter:blur(14px);border-bottom:1px solid var(--markr-line)}
.site-header-inner{max-width:1440px;margin:auto;padding:0 clamp(18px,4vw,64px);height:72px;display:flex;align-items:center;gap:44px}
.wordmark{display:flex;align-items:center;gap:10px;font-size:23px;letter-spacing:-.04em;font-weight:650;color:var(--markr-text);text-decoration:none;white-space:nowrap}
.brand-symbol{width:17px;height:17px;display:inline-block;border:1px solid var(--markr-muted);border-radius:50%;box-shadow:inset 0 0 0 4px var(--markr-bg),inset 0 0 0 5px var(--markr-accent)}
.brand-label{font-size:10px;letter-spacing:.08em;font-weight:400;color:var(--markr-muted);margin-left:8px}
.primary-nav{display:flex;gap:8px;align-items:center}.nav-item,.studio-link{color:var(--markr-muted);font-size:14px;text-decoration:none;padding:9px 12px;border-radius:var(--markr-radius-small);transition:color .15s,background .15s;white-space:nowrap}.nav-item:hover,.nav-item.selected{color:var(--markr-text);background:var(--markr-surface)}
.studio-link{margin-left:auto;color:var(--markr-text);border:1px solid var(--markr-line-strong)}.studio-link:hover,.studio-link.selected{border-color:var(--markr-accent);background:var(--markr-surface)}
.skip-link{position:absolute;left:18px;top:-60px;padding:10px;background:var(--markr-accent);color:var(--markr-bg)}.skip-link:focus{top:10px}
@media(max-width:900px){.brand-label{display:none}.site-header-inner{gap:24px}}
@media(max-width:520px){.site-header-inner{height:64px;gap:8px;padding:0 16px}.wordmark{font-size:20px;gap:6px}.brand-symbol{width:14px;height:14px}.primary-nav{gap:0}.nav-item{font-size:13px;padding:8px}.studio-link{padding:8px;font-size:12px}.studio-link span{display:none}}
@media(max-width:350px){.brand-symbol{display:none}.site-header-inner{gap:4px;padding:0 12px}.nav-item{padding:7px}}
</style>
