<template><footer class="site-footer"><div><span>Markr</span><p>记录你的视角。</p></div><small>Beta {{version}} · © {{year}} timeStarry</small></footer></template>
<script setup>
const version=__APP_VERSION__, year=new Date().getFullYear()
</script>
<style scoped>
.site-footer{max-width:1440px;width:100%;margin:auto;padding:28px clamp(18px,4vw,64px);border-top:1px solid var(--markr-line);display:flex;justify-content:space-between;align-items:center;gap:24px;color:var(--markr-muted)}.site-footer span{font-size:14px;color:var(--markr-text)}.site-footer p{font-size:12px;margin-top:4px}.site-footer small{font-size:11px;letter-spacing:.04em}@media(max-width:520px){.site-footer{padding:24px 18px;align-items:flex-start;gap:12px}.site-footer small{text-align:right}}
</style>
