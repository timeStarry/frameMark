<script setup lang="ts">
import { ref, shallowRef, computed, watch, onMounted, onUnmounted } from 'vue';
import NumberControl from '../components/NumberControl.vue';
import { defaults, History, Jobs, applyPreset, dimensions, outputSize, type Document } from '../core/document';
import { Assets, fields, type Asset } from '../engine/assets';
import { render, encode, download, disposeDownloads } from '../engine/render';
import '../workspace.css';
const repository = new Assets(), history = new History(defaults()), previewJobs = new Jobs(), tasks = new Jobs();
const doc = ref<Document>(defaults()), asset = shallowRef<Asset>(), canvas = ref<HTMLCanvasElement>(), fileInput = ref<HTMLInputElement>(), error = ref(''), status = ref(''), busy = ref(false), revision = ref(0), zoom = ref('fit'), mobilePanel = ref('properties'), exportOpen = ref(false), result = shallowRef<Blob>(), resultRevision = ref(-1), filename = ref('markr-watermark');
let previewTimer = 0;
const canUndo = computed(() => { revision.value; return history.past.length > 0; }), canRedo = computed(() => { revision.value; return history.future.length > 0; }), size = computed(() => asset.value ? outputSize(dimensions(doc.value, asset.value), doc.value.longEdge) : null);
function snapshot() { return structuredClone({ ...doc.value, assetIds: [...doc.value.assetIds], fields: [...doc.value.fields], fieldValues: { ...doc.value.fieldValues } }); }
function commit() { history.commit(snapshot()); revision.value++; prune(); }
function prune() { const refs = new Set([...doc.value.assetIds, ...history.past.flatMap(d => d.assetIds), ...history.future.flatMap(d => d.assetIds)]); repository.prune(refs); }
function restore(d: Document) { doc.value = structuredClone(d); asset.value = repository.items.get(d.assetIds[0] || ''); revision.value++; }
function undo() { restore(history.undo()); }
function redo() { restore(history.redo()); }
function preset(name: string) { doc.value = applyPreset(snapshot(), name); commit(); }
function reset() { doc.value = { ...defaults(), assetIds: [...doc.value.assetIds] }; commit(); }
function clear() { if (!confirm('清空当前照片？可通过撤销恢复。'))
    return; doc.value.assetIds = []; asset.value = undefined; commit(); previewJobs.cancel(); }
async function importFiles(files: File[]) { if (!files[0])
    return; const id = tasks.start(); busy.value = true; error.value = ''; status.value = '正在导入'; let added: Asset | undefined; try {
    added = await repository.add(files[0]);
    tasks.check(id);
    asset.value = added;
    doc.value.assetIds = [added.id];
    commit();
    status.value = '照片已导入';
}
catch (e) {
    if (id === tasks.version && (e as Error).name !== 'AbortError')
        error.value = (e as Error).message;
    if (added && asset.value !== added)
        prune();
}
finally {
    if (id === tasks.version)
        busy.value = false;
} }
function choose(event: Event) { const input = event.target as HTMLInputElement; void importFiles(Array.from(input.files || [])); input.value = ''; }
function drop(event: DragEvent) { void importFiles(Array.from(event.dataTransfer?.files || [])); }
async function preview() { if (!asset.value || !canvas.value)
    return; const id = previewJobs.start(), target = document.createElement('canvas'); try {
    await render(snapshot(), asset.value, target, true, () => previewJobs.check(id), () => { });
    previewJobs.check(id);
    canvas.value.width = target.width;
    canvas.value.height = target.height;
    canvas.value.getContext('2d')?.drawImage(target, 0, 0);
}
catch (e) {
    if (id === previewJobs.version && (e as Error).name !== 'AbortError')
        error.value = (e as Error).message;
}
finally {
    target.width = target.height = 0;
} }
watch(doc, () => { resultRevision.value = -1; window.clearTimeout(previewTimer); previewTimer = window.setTimeout(() => void preview(), 150); }, { deep: true });
watch(asset, () => void preview(), { flush: 'post' });
function cancel() { tasks.cancel(); busy.value = false; status.value = '已取消；文档已保留。'; }
async function exportImage() { if (!asset.value || busy.value)
    return; commit(); const id = tasks.start(), d = snapshot(), a = asset.value, rev = revision.value, target = document.createElement('canvas'); busy.value = true; error.value = ''; result.value = undefined; try {
    await render(d, a, target, false, () => tasks.check(id), s => status.value = s);
    tasks.check(id);
    status.value = '正在编码（浏览器不提供百分比）';
    const blob = await encode(target, d);
    tasks.check(id);
    result.value = blob;
    resultRevision.value = rev;
    status.value = `导出完成 · ${(blob.size / 1024 / 1024).toFixed(2)} MiB`;
}
catch (e) {
    if ((e as Error).name !== 'AbortError')
        error.value = (e as Error).message;
}
finally {
    target.width = target.height = 0;
    if (id === tasks.version)
        busy.value = false;
} }
function save() { if (result.value && resultRevision.value === revision.value) {
    const ext = doc.value.format.split('/')[1]!.replace('jpeg', 'jpg');
    download(result.value, `${filename.value || 'markr'}.${ext}`);
} }
function keyboard(e: KeyboardEvent) { if (e.key === 'Escape') {
    if (busy.value)
        cancel();
    else
        exportOpen.value = false;
} const el = e.target as HTMLElement; if (el.matches('input,textarea,[contenteditable]'))
    return; if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
} }
onMounted(() => window.addEventListener('keydown', keyboard));
onUnmounted(() => { window.removeEventListener('keydown', keyboard); window.clearTimeout(previewTimer); previewJobs.cancel(); tasks.cancel(); repository.dispose(); disposeDownloads(); if (canvas.value)
    canvas.value.width = canvas.value.height = 0; });
</script>
<template>
<section class="editor-workspace" @dragover.prevent @drop.prevent="drop">
<header class="editor-toolbar">
<div>
<router-link to="/tools">工具箱 /</router-link>
<h1>边框水印</h1>
<small>本地处理 · 无需账号 · 不上传</small>
</div>
<div class="toolbar-actions">
<button :disabled="!canUndo||busy" @click="undo">撤销</button>
<button :disabled="!canRedo||busy" @click="redo">重做</button>
<button :disabled="!asset||busy" @click="reset">重置设置</button>
<button class="primary" :disabled="!asset" @click="exportOpen=!exportOpen">导出</button>
</div>
</header>
<p v-if="error" role="alert" class="editor-error">{{error}} <button @click="error=''">关闭</button>
</p>
<div v-if="status" class="task-status" role="status">{{status}} <button v-if="busy" @click="cancel">取消</button>
</div>
<div class="mobile-tabs">
<button :aria-pressed="mobilePanel==='assets'" @click="mobilePanel='assets'">素材</button>
<button :aria-pressed="mobilePanel==='properties'" @click="mobilePanel='properties'">属性</button>
</div>
<div class="editor-grid">
<aside class="asset-panel" :class="{'mobile-active':mobilePanel==='assets'}">
<h2>素材</h2>
<input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp" hidden @change="choose">
<button :disabled="busy" @click="fileInput?.click()">{{asset?'替换照片':'导入照片'}}</button>
<div v-if="asset" class="asset-item">
<img :src="asset.url" alt="当前照片">
<strong>{{asset.file.name}}</strong>
<small>{{asset.width}} × {{asset.height}} px</small>
<button :disabled="busy" @click="clear">移除</button>
</div>
<p>JPEG / PNG / WebP<br>20 MiB · 4000 万像素上限</p>
</aside>
<div class="canvas-panel">
<div class="canvas-viewport" :class="{'fit':zoom==='fit'}">
<canvas v-show="asset" ref="canvas" role="img" aria-label="照片边框与文字的本地预览" :style="zoom==='fit'?{}:{width:((canvas?.width||0)*Number(zoom))+'px',maxWidth:'none'}">
</canvas>
<div v-if="!asset" class="editor-empty">
<h2>从一张照片开始</h2>
<p>拖入照片，或选择本地文件。</p>
<button @click="fileInput?.click()">选择照片</button>
</div>
</div>
<div class="canvas-status">
<span>预览 {{size?`${size.width} × ${size.height} px 导出`:''}}</span>
<label>缩放 <select v-model="zoom">
<option value="fit">适应</option>
<option value="0.25">25%</option>
<option value="0.5">50%</option>
<option value="1">100%</option>
<option value="2">200%</option>
</select>
</label>
</div>
</div>
<aside class="inspector" :class="{'mobile-active':mobilePanel==='properties'}">
<fieldset :disabled="!asset||busy">
<legend>预设</legend>
<div class="preset-grid">
<button @click="preset('light')">留白</button>
<button @click="preset('dark')">暗色</button>
<button @click="preset('soft')">柔焦</button>
<button @click="preset('caption')">底部题签</button>
</div>
</fieldset>
<fieldset :disabled="!asset||busy">
<legend>边框</legend>
<label>类型<select v-model="doc.frame" @change="commit">
<option value="solid">纯色</option>
<option value="gradient">渐变</option>
<option value="blur">模糊背景</option>
<option value="bottom-bar">底部条幅</option>
</select>
</label>
<NumberControl label="边距" v-model="doc.border" :min="0" :max="20" unit="% 短边" @commit="commit"/>
<NumberControl v-if="doc.frame==='bottom-bar'" label="底条高度" v-model="doc.bottom" :min="0" :max="30" unit="%" @commit="commit"/>
<NumberControl label="圆角" v-model="doc.radius" :min="0" :max="10" unit="%" @commit="commit"/>
<label>背景颜色<input type="color" v-model="doc.color" @change="commit">
</label>
<label v-if="doc.format!=='image/jpeg'&&doc.frame==='solid'" class="check-row">
<input type="checkbox" v-model="doc.transparent" @change="commit">透明边框</label>
<label v-if="doc.frame==='gradient'">第二颜色<input type="color" v-model="doc.secondColor" @change="commit">
</label>
<NumberControl v-if="doc.frame==='blur'" label="模糊" v-model="doc.blur" :min="0.5" :max="5" :step="0.5" unit="%" @commit="commit"/>
</fieldset>
<fieldset :disabled="!asset||busy">
<legend>文字</legend>
<label>签名或说明<textarea v-model="doc.text" maxlength="200" rows="3" @change="commit" placeholder="文字默认不添加">
</textarea>
</label>
<label>字体<select v-model="doc.font" @change="commit">
<option value="sans-serif">系统无衬线</option>
<option value="serif">系统衬线</option>
<option value="monospace">系统等宽</option>
</select>
</label>
<NumberControl label="字号" v-model="doc.size" :min="0.5" :max="8" :step="0.5" unit="%" @commit="commit"/>
<NumberControl label="透明度" v-model="doc.opacity" :min="0" :max="1" :step="0.05" @commit="commit"/>
<label>文字颜色<input type="color" v-model="doc.textColor" @change="commit">
</label>
<label>位置<select v-model="doc.position" @change="commit">
<option v-for="(name,i) in ['左上','上中','右上','左中','中心','右中','左下','下中','右下']" :key="i" :value="i">{{name}}</option>
</select>
</label>
</fieldset>
<fieldset :disabled="!asset||busy">
<legend>拍摄参数（可选）</legend>
<p>只读取拍摄字段，不读取位置；导出不复制原始元数据。</p>
<label v-for="(name,key) in fields" :key="key" class="check-row">
<input type="checkbox" :value="key" v-model="doc.fields" :disabled="!asset?.metadata[key]" @change="commit">{{name}} <small>{{asset?.metadata[key]||'无信息'}}</small>
</label>
<label v-for="key in doc.fields" :key="'edit-'+key">{{fields[key]}}显示值<input :value="doc.fieldValues[key]||asset?.metadata[key]" maxlength="100" @change="doc.fieldValues[key]=($event.target as HTMLInputElement).value;commit()">
</label>
</fieldset>
</aside>
</div>
<section v-if="exportOpen" class="export-panel" aria-label="导出设置">
<h2>导出照片</h2>
<div class="export-controls">
<label>文件名<input v-model="filename" maxlength="100">
</label>
<label>格式<select v-model="doc.format" :disabled="busy" @change="commit">
<option value="image/jpeg">JPEG（不透明背景）</option>
<option value="image/png">PNG</option>
<option value="image/webp">WebP</option>
</select>
</label>
<NumberControl label="长边（0 = 原尺寸加框）" v-model="doc.longEdge" :min="0" :max="8192" @commit="commit"/>
<NumberControl v-if="doc.format!=='image/png'" label="质量" v-model="doc.quality" :min="1" :max="100" @commit="commit"/>
</div>
<p>{{size?.width}} × {{size?.height}} px · 最多1600万像素。编码阶段无法显示百分比，取消会丢弃结果。</p>
<button class="primary" :disabled="busy||!asset" @click="exportImage">生成文件</button> <button :disabled="!result||resultRevision!==revision||busy" @click="save">下载文件</button>
<small v-if="result&&resultRevision!==revision">设置已变化，请重新生成。</small>
</section>
</section>
</template>
