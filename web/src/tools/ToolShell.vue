<script setup lang="ts">
// Shared shell for both tools (spec §2.3, §6): canvas on the left, panel on
// the right, bottom sheet on phones. Slots: controls (the tool panel) and
// actions (export buttons, injected by the tool).
import { ref, useId } from 'vue'
import WallNav from '../walls/WallNav.vue'

defineProps<{ title: string; scaleNote?: string; exporting?: boolean; exportError?: string }>()
defineEmits<{ download: [] }>()
const uid = useId()
const canvas = ref<HTMLCanvasElement | null>(null)
defineExpose({ canvas })
</script>

<template>
  <div class="tool-shell">
    <WallNav />
    <header class="bar">
      <h1 :id="`${uid}-title`" tabindex="-1">{{ title }}</h1>
      <p v-if="scaleNote" class="note" role="status">{{ scaleNote }}</p>
      <p v-if="exportError" class="error" role="alert">{{ exportError }}</p>
    </header>
    <div class="body">
      <section class="canvas-col" :aria-label="title + ' 预览'">
        <canvas ref="canvas" class="preview" />
      </section>
      <section class="panel-col" :aria-label="title + ' 设置'">
        <slot name="controls" />
        <div class="actions">
          <button type="button" class="primary" :disabled="exporting" @click="$emit('download')">
            {{ exporting ? '导出中…' : '下载' }}
          </button>
          <slot name="actions" />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tool-shell { min-height: 100vh; background: var(--bg-wall); }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-8) var(--space-16); padding: var(--space-16) max(16px, 2vw); border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-family: var(--font-title); font-weight: 400; font-size: 1.25rem; }
h1:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.note { margin: 0; color: var(--fg-muted); }
.error { margin: 0; color: var(--fg); }
.body { display: grid; grid-template-columns: 1fr minmax(320px, 400px); gap: var(--space-16); padding: var(--space-16) max(16px, 2vw); }
.canvas-col { display: flex; align-items: start; justify-content: center; }
.preview { max-width: 100%; max-height: 80vh; background: var(--bg-view); }
.panel-col { display: flex; flex-direction: column; gap: var(--space-16); overflow-y: auto; max-height: calc(100vh - 120px); }
.actions { display: flex; gap: var(--space-8); padding-top: var(--space-16); border-top: 1px solid var(--line); }
button { min-height: 44px; padding: 0 var(--space-16); border: 1px solid var(--line); background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
button.primary { border-color: var(--accent); }
button:disabled { opacity: 0.45; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
@media (max-width: 767px) {
  .body { grid-template-columns: 1fr; }
  .panel-col { max-height: none; }
}
</style>
