<script setup lang="ts">
import { ref, nextTick, watch } from 'vue';
import type { Asset } from '../engine/assets';
const props = defineProps<{
    assets: Asset[];
    selected: string;
    busy: boolean;
    multiple?: boolean;
}>(), emit = defineEmits<{
    import: [
        files: File[],
        replaceId?: string
    ];
    select: [
        id: string
    ];
    remove: [
        id: string
    ];
    move: [
        id: string,
        delta: number
    ];
    clear: [
    ];
}>(), fileInput = ref<HTMLInputElement>(), replacement = ref<string>(), list = ref<HTMLElement>();
let importFocus: HTMLElement | null = null, importFromRail = false, awaitingImport = false;
async function pick(id?: string) {
    if (props.busy) return;
    importFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    importFromRail = !!importFocus && !!list.value?.contains(importFocus);
    replacement.value = id;
    await nextTick();
    fileInput.value?.click();
}
function choose(e: Event) {
    const input = e.target as HTMLInputElement, files = Array.from(input.files || []);
    awaitingImport = files.length > 0;
    emit('import', files, replacement.value);
    input.value = '';
    replacement.value = undefined;
}
watch(() => props.busy, async busy => {
    if (busy || !awaitingImport) return;
    awaitingImport = false;
    const anchor = importFocus;
    importFocus = null;
    await nextTick();
    const active = document.activeElement;
    if (!anchor || (active !== anchor && active !== document.body && active !== fileInput.value)) return;
    if (anchor.isConnected && !anchor.hasAttribute('disabled')) anchor.focus({ preventScroll: true });
    else if (importFromRail) list.value?.querySelector<HTMLButtonElement>(`[data-asset-id="${props.selected}"] .asset-select`)?.focus({ preventScroll: true });
    else list.value?.closest('.editor-workspace')?.querySelector<HTMLSelectElement>('.canvas-status select')?.focus({ preventScroll: true });
});
async function remove(id: string) { const index = props.assets.findIndex(a => a.id === id); emit('remove', id); await nextTick(); const buttons = list.value?.querySelectorAll<HTMLButtonElement>('.asset-select'); (buttons?.[Math.min(index, (buttons?.length || 1) - 1)] || list.value?.querySelector<HTMLButtonElement>('.asset-add'))?.focus(); }
async function clear() { emit('clear'); await nextTick(); if (!props.assets.length) list.value?.querySelector<HTMLButtonElement>('.asset-add')?.focus(); }
async function move(id: string, delta: number) { emit('move', id, delta); await nextTick(); list.value?.querySelector<HTMLButtonElement>(`[data-asset-id="${id}"] .asset-select`)?.focus(); }
defineExpose({ pick });
</script>
<template>
<div ref="list" class="asset-library">
<h2>素材 <small>{{assets.length}}{{multiple?' / 12':''}}</small>
</h2>
<input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp" :multiple="multiple&&!replacement" hidden @change="choose">
<button class="asset-add" :disabled="busy||!!multiple&&assets.length>=12" @click="pick(multiple?undefined:assets[0]?.id)">{{!multiple&&assets.length?'替换照片':'导入照片'}}</button>
<div class="asset-list">
<div v-for="(a,i) in assets" :key="a.id" :data-asset-id="a.id" class="asset-item" :class="{selected:a.id===selected}">
<button class="asset-select" :aria-pressed="a.id===selected" @click="emit('select',a.id)">
<img :src="a.url" alt="" :width="a.width" :height="a.height">
<span class="asset-name">{{i+1}}. {{a.file.name}}</span>
<small>{{a.width}} × {{a.height}} px</small>
</button>
<div class="asset-actions">
<button :disabled="busy" :aria-label="'替换 '+a.file.name" @click="pick(a.id)">替换</button>
<button :disabled="busy" :aria-label="'移除 '+a.file.name" @click="remove(a.id)">移除</button>
<template v-if="multiple">
<button :disabled="busy||i===0" :aria-label="'前移 '+a.file.name" @click="move(a.id,-1)">↑</button>
<button :disabled="busy||i===assets.length-1" :aria-label="'后移 '+a.file.name" @click="move(a.id,1)">↓</button>
</template>
</div>
</div>
</div>
<button v-if="assets.length>1" :disabled="busy" @click="clear">清空素材</button>
<p class="asset-limits">JPEG、PNG、静态 WebP<br>每张 ≤ 20 MiB / 4000 万像素</p>
</div>
</template>
