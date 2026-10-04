<script setup>
const tools = [
  { path: '/frame-watermark', title: '边框水印', description: '添加边框、签名与拍摄参数。', shape: 'frame' },
  { path: '/image-collage', title: '图片拼图', description: '排列照片，调整每一格的构图。', shape: 'collage' }
]
</script>
<template>
  <section class="markr-page toolbox-page" aria-labelledby="toolbox-title">
    <h1 id="toolbox-title">工具箱</h1>
    <p class="local-note">无需登录，不自动上传。</p>
    <div class="tool-grid">
      <router-link v-for="tool in tools" :key="tool.path" :to="tool.path" class="tool-entry">
        <div class="tool-illustration" aria-hidden="true">
          <svg v-if="tool.shape === 'frame'" viewBox="0 0 320 220" fill="none">
            <path d="M66 28h188v164H66z" class="outer-line"/>
            <path d="M83 45h154v113H83zM144 175h32"/>
          </svg>
          <svg v-else viewBox="0 0 320 220" fill="none">
            <path d="M40 35h240v150H40z" class="outer-line"/>
            <path d="M53 48h98v124H53zM163 48h104v56H163zM163 116h104v56H163z"/>
          </svg>
        </div>
        <div class="tool-copy"><h2>{{ tool.title }}<span aria-hidden="true">→</span></h2><p>{{ tool.description }}</p></div>
      </router-link>
    </div>
  </section>
</template>
<style scoped>
.toolbox-page{max-width:1200px;padding-top:64px;padding-bottom:96px}
.toolbox-page h1{font-size:32px;line-height:1.3;font-weight:500;letter-spacing:-.03em}
.local-note{color:var(--markr-muted);font-size:14px;margin-top:12px}
.tool-grid{display:grid;grid-template-columns:1fr 1fr;gap:64px;margin-top:48px}
.tool-entry{display:block;min-width:0;color:inherit;text-decoration:none}
.tool-illustration{height:260px;display:flex;align-items:center;justify-content:center;background:var(--markr-surface)}
.tool-illustration svg{width:85%;max-width:360px;height:100%;stroke:var(--markr-muted);stroke-width:1;transition:stroke var(--markr-motion-control) var(--markr-ease-control)}
.tool-illustration .outer-line{stroke:var(--markr-accent)}
.tool-entry:hover svg{stroke:var(--markr-text)}
.tool-copy{padding-top:24px}
.tool-copy h2{display:flex;align-items:center;justify-content:space-between;font-size:23px;font-weight:500}
.tool-copy h2 span{font-size:20px;color:var(--markr-muted)}
.tool-copy p{margin-top:8px;color:var(--markr-muted);font-size:14px}
@media(max-width:700px){.toolbox-page{padding-top:32px;padding-bottom:48px}.tool-grid{grid-template-columns:1fr;gap:40px;margin-top:32px}.tool-illustration{height:220px}.tool-copy{padding-top:16px}}
</style>
