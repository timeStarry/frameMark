<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import NumberControl from './NumberControl.vue';
import type { OutputSettings, Size } from '../core/document';
const props = defineProps<{
    open: boolean;
    settings: OutputSettings;
    size: Size | null;
    busy: boolean;
    hasAssets: boolean;
    hasResult: boolean;
    stale: boolean;
    filename: string;
    watermark?: boolean;
}>(), emit = defineEmits<{
    commit: [
    ];
    generate: [
    ];
    download: [
    ];
    'update:filename': [
        value: string
    ];
    close: [
    ];
}>(), heading = ref<HTMLElement>();
let returnFocus: HTMLElement | null = null;
watch(() => props.open, async (open) => { if (open) {
    returnFocus = document.activeElement as HTMLElement;
    await nextTick();
    heading.value?.focus();
}
else {
    returnFocus?.focus();
} }, { flush: 'post' });
</script>
<template>
<section v-if="open" class="export-panel" aria-label="导出设置">
<h2 ref="heading" tabindex="-1">导出照片 <button @click="emit('close')">关闭</button>
</h2>
<fieldset :disabled="busy">
<div class="export-controls">
<label>文件名<input :value="filename" maxlength="100" @input="emit('update:filename',($event.target as HTMLInputElement).value)">
</label>
<label>格式<select v-model="settings.format" @change="emit('commit')">
<option value="image/jpeg">JPEG（不透明背景）</option>
<option value="image/png">PNG（可透明）</option>
<option value="image/webp">WebP（可透明）</option>
</select>
</label>
<NumberControl v-if="watermark" label="长边（0 = 原尺寸加框）" v-model="settings.longEdge" :min="0" :max="8192" @commit="emit('commit')"/>
<NumberControl v-if="settings.format!=='image/png'" label="质量" v-model="settings.quality" :min="1" :max="100" @commit="emit('commit')"/>
</div>
</fieldset>
<p>{{size?.width}} × {{size?.height}} px · 输出最多1600万像素，长边8192px。编码阶段不提供百分比；取消后丢弃迟到结果。</p>
<button class="primary" :disabled="busy||!hasAssets" @click="emit('generate')">生成文件</button> <button :disabled="!hasResult||stale||busy" @click="emit('download')">下载文件</button>
<small v-if="hasResult&&stale">设置已变化，请重新生成。</small>
</section>
</template>
