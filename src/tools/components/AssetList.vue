<script setup lang="ts">
import { ref, nextTick } from 'vue';
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
async function pick(id?: string) { replacement.value = id; await nextTick(); fileInput.value?.click(); }
function choose(e: Event) { const input = e.target as HTMLInputElement; emit('import', Array.from(input.files || []), replacement.value); input.value = ''; replacement.value = undefined; }
async function remove(id: string) { const index = props.assets.findIndex(a => a.id === id); emit('remove', id); await nextTick(); const buttons = list.value?.querySelectorAll<HTMLButtonElement>('.asset-select'); (buttons?.[Math.min(index, (buttons?.length || 1) - 1)] || list.value?.querySelector<HTMLButtonElement>('.asset-add'))?.focus(); }
defineExpose({ pick });
</script>
<template>
<div ref="list">
<h2>素材 <small>{{assets.length}}{{multiple?' / 12':''}}</small>
</h2>
<input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp" :multiple="multiple&&!replacement" hidden @change="choose">
<button class="asset-add" :disabled="busy||!!multiple&&assets.length>=12" @click="pick(multiple?undefined:assets[0]?.id)">{{!multiple&&assets.length?'替换照片':'导入照片'}}</button>
<div class="asset-list">
<div v-for="(a,i) in assets" :key="a.id" class="asset-item" :class="{selected:a.id===selected}">
<button class="asset-select" :aria-pressed="a.id===selected" @click="emit('select',a.id)">
<img :src="a.url" :alt="a.file.name">
<strong>{{i+1}}. {{a.file.name}}</strong>
<small>{{a.width}} × {{a.height}} px</small>
</button>
<div class="asset-actions">
<button :disabled="busy" @click="pick(a.id)">替换</button>
<button :disabled="busy" @click="remove(a.id)">移除</button>
<template v-if="multiple">
<button :disabled="busy||i===0" :aria-label="'前移 '+a.file.name" @click="emit('move',a.id,-1)">↑</button>
<button :disabled="busy||i===assets.length-1" :aria-label="'后移 '+a.file.name" @click="emit('move',a.id,1)">↓</button>
</template>
</div>
</div>
</div>
<button v-if="assets.length>1" :disabled="busy" @click="emit('clear')">清空素材</button>
<p>JPEG / PNG / 静态 WebP<br>每张 20 MiB · 4000 万像素<br>重复文件允许添加；原图保留供导出。</p>
</div>
</template>
