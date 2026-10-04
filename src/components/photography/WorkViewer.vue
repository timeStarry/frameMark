<script setup>
import { computed, ref, watch } from 'vue'
import PhotoMedia from './PhotoMedia.vue'

const props = defineProps({ work: { type: Object, required: true } })
const emit = defineEmits(['back'])
const active = ref(0)
const media = computed(() => {
  const descriptors = Array.isArray(props.work.media) ? props.work.media : []
  const assets = Array.isArray(props.work.assets) ? props.work.assets : []
  return (assets.length ? assets : descriptors).map(asset => {
    const id = typeof asset === 'string' ? asset : asset?.id
    return descriptors.find(item => item?.id === id) || (typeof asset === 'object' ? asset : { id })
  }).filter(item => typeof item?.id === 'string' && item.id.length > 0)
})
const current = computed(() => media.value[active.value])
const title = computed(() => props.work.title?.trim() || '未命名作品')
const author = computed(() => props.work.photographerName?.trim() ? `@${props.work.photographerName.trim()}` : '摄影师')
const profilePath = computed(() => props.work.photographer ? `/profile/${encodeURIComponent(props.work.photographer)}` : null)
const imageDescription = computed(() => `${title.value}${media.value.length > 1 ? ` · 第 ${active.value + 1} 张` : ''}`)
const originalPath = computed(() => props.work.allowOriginal === true && current.value
  ? `/api/media/${encodeURIComponent(current.value.id)}/original` : null)

watch(() => props.work.id, () => { active.value = 0 }, { immediate: true })
watch(media, items => { active.value = Math.min(active.value, Math.max(0, items.length - 1)) })
function step(direction) {
  if (media.value.length < 2) return
  active.value = (active.value + direction + media.value.length) % media.value.length
}
function keydown(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const target = event.target
  if (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return
  if (media.value.length > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault()
    step(event.key === 'ArrowLeft' ? -1 : 1)
  }
}
</script>

<template>
  <article class="work-viewer" tabindex="0" aria-label="作品观看" @keydown="keydown">
    <nav class="work-viewer__nav" aria-label="作品导航">
      <button type="button" class="work-viewer__back" @click="emit('back')"><span aria-hidden="true">←</span> 返回</button>
      <router-link v-if="profilePath" class="work-viewer__author" :to="profilePath">{{ author }}</router-link>
      <span v-else class="work-viewer__author">{{ author }}</span>
    </nav>

    <template v-if="current">
      <div class="work-viewer__stage">
        <PhotoMedia :media="current" :alt="imageDescription" eager fit="contain" />
      </div>
      <div class="work-viewer__controls" aria-label="组图浏览">
        <button type="button" :disabled="media.length < 2" aria-label="上一张照片" @click="step(-1)"><span aria-hidden="true">←</span><span>上一张</span></button>
        <span class="work-viewer__count" role="status" aria-live="polite" aria-atomic="true" :aria-label="`第 ${active + 1} 张，共 ${media.length} 张`">{{ active + 1 }} <span aria-hidden="true">/</span> {{ media.length }}</span>
        <button type="button" :disabled="media.length < 2" aria-label="下一张照片" @click="step(1)"><span>下一张</span><span aria-hidden="true">→</span></button>
      </div>
    </template>

    <div class="work-viewer__details" :class="{ 'work-viewer__details--text': !current }">
      <h1>{{ title }}</h1>
      <p v-if="work.text" class="work-viewer__text">{{ work.text }}</p>
      <div v-if="work.aiDeclaration || work.license || originalPath" class="work-viewer__permissions">
        <p v-if="work.aiDeclaration?.label">{{ work.aiDeclaration.label }}</p>
        <a v-if="work.license?.url" :href="work.license.url" target="_blank" rel="noopener noreferrer">{{ work.license.label }} · 官方许可说明 <span aria-hidden="true">↗</span><span class="work-viewer__sr">（新窗口）</span></a>
        <a v-if="originalPath" :href="originalPath">下载原文件 <span aria-hidden="true">↓</span></a>
      </div>
    </div>
  </article>
</template>

<style scoped>
.work-viewer{width:100%;max-width:1440px;margin:0 auto;color:var(--markr-text,#eeeee9);outline:none}
.work-viewer:focus-visible{outline:2px solid var(--markr-accent,#ccd4c4);outline-offset:8px}
.work-viewer__nav{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:44px}
.work-viewer button{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-width:44px;min-height:44px;padding:8px 12px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--markr-text,#eeeee9);font:inherit;font-size:13px;line-height:1.5;cursor:pointer;transition:border-color 140ms cubic-bezier(.2,0,0,1)}
.work-viewer button:hover:not(:disabled){border-color:var(--markr-line-strong,#41494d)}
.work-viewer button:disabled{color:var(--markr-muted,#a0a4a8);opacity:.5;cursor:default}
.work-viewer a{color:var(--markr-muted,#a0a4a8);text-decoration:none}
.work-viewer a:hover{text-decoration:underline;text-underline-offset:4px}
.work-viewer button:focus-visible,.work-viewer a:focus-visible{outline:2px solid var(--markr-accent,#ccd4c4);outline-offset:3px}
.work-viewer__back{margin-left:-12px}
.work-viewer__author{display:inline-flex;align-items:center;min-height:44px;max-width:70%;overflow-wrap:anywhere;font-size:13px;line-height:1.5;text-align:right}
.work-viewer__stage{width:100%;height:clamp(240px,70vh,900px);height:clamp(240px,70svh,900px);margin-top:24px}
.work-viewer__stage :deep(.photo-media){height:100%;aspect-ratio:auto;background:transparent}
.work-viewer__controls{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:16px;margin-top:12px}
.work-viewer__controls button:first-child{justify-self:start}
.work-viewer__controls button:last-child{justify-self:end}
.work-viewer__count{min-width:64px;color:var(--markr-muted,#a0a4a8);font-size:12px;font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap}
.work-viewer__count>span{display:inline-block;margin:0 8px}
.work-viewer__details{max-width:760px;margin:48px auto 32px}
.work-viewer__details--text{margin-top:64px;min-height:32vh}
.work-viewer__details h1{margin:0;font-size:clamp(28px,3vw,36px);font-weight:400;line-height:1.4;letter-spacing:-.025em;overflow-wrap:anywhere}
.work-viewer__text{margin:24px 0 0;color:var(--markr-text,#eeeee9);font-size:15px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere}
.work-viewer__permissions{display:flex;flex-wrap:wrap;align-items:center;column-gap:24px;row-gap:4px;margin-top:32px;padding-top:16px;border-top:1px solid var(--markr-line,#282d31);color:var(--markr-muted,#a0a4a8);font-size:12px;line-height:1.7}
.work-viewer__permissions p{flex-basis:100%;margin:0 0 4px}
.work-viewer__permissions a{display:inline-flex;align-items:center;gap:6px;min-height:44px;overflow-wrap:anywhere}
.work-viewer__sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media(max-width:600px){.work-viewer__stage{margin-top:16px;height:clamp(240px,58vh,640px);height:clamp(240px,58svh,640px)}.work-viewer__controls{gap:8px}.work-viewer__details{margin-top:32px}.work-viewer__details--text{margin-top:40px}.work-viewer__permissions{margin-top:24px}}
@media(prefers-reduced-motion:reduce){.work-viewer button{transition:none}}
</style>
