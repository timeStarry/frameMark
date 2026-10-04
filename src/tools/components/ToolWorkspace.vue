<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import '../workspace.css';
defineProps<{
    title: string;
    busy: boolean;
    canUndo: boolean;
    canRedo: boolean;
    hasAssets: boolean;
    error: string;
    status: string;
}>();
const emit = defineEmits<{
    undo: []; redo: []; reset: []; export: []; cancel: []; dismiss: []; drop: [files: File[]];
}>();
const panel = ref('properties'), workspace = ref<HTMLElement>();
let mobile: MediaQueryList | undefined;
let focusedPanel = '', focusedElement: HTMLElement | null = null;
function rememberFocus(event: FocusEvent) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    focusedPanel = target.closest('.asset-panel') ? 'assets' : target.closest('.inspector') ? 'properties' : '';
    focusedElement = target;
}
async function preservePanelFocus() {
    if (!mobile || !workspace.value) return;
    const focus = document.activeElement;
    if (mobile.matches && focusedPanel && focusedElement?.isConnected && (focus === focusedElement || focus === document.body)) {
        panel.value = focusedPanel;
        await nextTick();
        focusedElement?.focus({ preventScroll: true });
    } else if (!mobile.matches && focus instanceof Element && focus.closest('.mobile-tabs')) {
        workspace.value.querySelector<HTMLElement>(panel.value === 'assets' ? '.asset-panel' : '.inspector')?.focus({ preventScroll: true });
    }
}
onMounted(() => {
    if (typeof window.matchMedia !== 'function') return;
    mobile = window.matchMedia('(max-width: 759px)');
    mobile.addEventListener('change', preservePanelFocus);
});
onUnmounted(() => mobile?.removeEventListener('change', preservePanelFocus));
</script>
<template>
<section ref="workspace" class="editor-workspace" @focusin="rememberFocus" @dragover.prevent @drop.prevent="emit('drop',Array.from($event.dataTransfer?.files||[]))">
  <header class="editor-toolbar">
    <div class="tool-heading"><router-link to="/tools">工具箱</router-link><h1>{{title}}</h1><p>本地处理，不自动上传。</p></div>
    <div class="toolbar-actions" aria-label="编辑操作">
      <button :disabled="!canUndo||busy" @click="emit('undo')">撤销</button>
      <button :disabled="!canRedo||busy" @click="emit('redo')">重做</button>
      <button :disabled="!hasAssets||busy" @click="emit('reset')">重置设置</button>
      <button class="primary" :disabled="!hasAssets" @click="emit('export')">导出</button>
    </div>
  </header>
  <p v-if="error" role="alert" class="editor-error">{{error}} <button @click="emit('dismiss')">关闭提示</button></p>
  <div v-if="status" class="task-status" role="status">{{status}} <button v-if="busy" @click="emit('cancel')">取消</button></div>
  <div class="editor-grid">
    <aside id="tool-assets" class="asset-panel" tabindex="-1" :class="{'mobile-active':panel==='assets'}" aria-label="素材"><slot name="assets"/></aside>
    <div class="canvas-panel"><slot name="canvas"/></div>
    <div class="mobile-tabs" role="group" aria-label="工作面板">
      <button aria-controls="tool-assets" :aria-pressed="panel==='assets'" @click="panel='assets'">素材</button>
      <button aria-controls="tool-properties" :aria-pressed="panel==='properties'" @click="panel='properties'">属性</button>
    </div>
    <aside id="tool-properties" class="inspector" tabindex="-1" :class="{'mobile-active':panel==='properties'}" aria-label="属性"><slot name="properties"/></aside>
  </div>
  <slot name="export"/>
</section>
</template>
