<script setup lang="ts">
import { ref } from 'vue';
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
    undo: [
    ];
    redo: [
    ];
    reset: [
    ];
    export: [
    ];
    cancel: [
    ];
    dismiss: [
    ];
    drop: [
        files: File[]
    ];
}>(), panel = ref('properties');
</script>
<template>
<section class="editor-workspace" @dragover.prevent @drop.prevent="emit('drop',Array.from($event.dataTransfer?.files||[]))">
<header class="editor-toolbar">
<div>
<router-link to="/tools">工具箱 /</router-link>
<h1>{{title}}</h1>
<small>本地处理 · 无需账号 · 不上传</small>
</div>
<div class="toolbar-actions">
<button :disabled="!canUndo||busy" @click="emit('undo')">撤销</button>
<button :disabled="!canRedo||busy" @click="emit('redo')">重做</button>
<button :disabled="!hasAssets||busy" @click="emit('reset')">重置设置</button>
<button class="primary" :disabled="!hasAssets" @click="emit('export')">导出</button>
</div>
</header>
<p v-if="error" role="alert" class="editor-error">{{error}} <button @click="emit('dismiss')">关闭</button>
</p>
<div v-if="status" class="task-status" role="status">{{status}} <button v-if="busy" @click="emit('cancel')">取消</button>
</div>
<div class="mobile-tabs">
<button :aria-pressed="panel==='assets'" @click="panel='assets'">素材</button>
<button :aria-pressed="panel==='properties'" @click="panel='properties'">属性</button>
</div>
<div class="editor-grid">
<aside class="asset-panel" :class="{'mobile-active':panel==='assets'}">
<slot name="assets"/>
</aside>
<div class="canvas-panel">
<slot name="canvas"/>
</div>
<aside class="inspector" :class="{'mobile-active':panel==='properties'}">
<slot name="properties"/>
</aside>
</div>
<slot name="export"/>
</section>
</template>
