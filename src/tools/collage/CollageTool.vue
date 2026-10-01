<script setup lang="ts">
import { computed, ref } from 'vue';
import ToolWorkspace from '../components/ToolWorkspace.vue';
import AssetList from '../components/AssetList.vue';
import CanvasViewport from '../components/CanvasViewport.vue';
import ExportPanel from '../components/ExportPanel.vue';
import NumberControl from '../components/NumberControl.vue';
import ColorControl from '../components/ColorControl.vue';
import { collageDefaults, cells, moveAsset, replaceAsset, type Placement } from '../core/collage';
import { useEditor } from '../core/useEditor';
import { renderDocument } from '../engine/pipeline';
const { doc, assets, canvas, selected, error, status, busy, revision, exportOpen, result, resultRevision, filename, canUndo, canRedo, size, snapshot, commit, undo, redo, reset, remove, clear, cancel, importFiles, exportImage, save } = useEditor(collageDefaults, renderDocument, d => ({ width: d.width, height: d.height }), 12);
filename.value = 'markr-collage';
const assetList = ref<InstanceType<typeof AssetList>>(), lockRatio = ref(false);
const active = computed(() => assets.value.find(a => a.id === selected.value));
const placement = computed(() => doc.value.placements[selected.value] || { x: 50, y: 50, fit: 'cover' as const });
const layout = computed(() => { try {
    return cells(doc.value);
}
catch {
    return [];
} });
const geometryError = computed(() => { try {
    cells(doc.value);
    return '';
}
catch (e) {
    return (e as Error).message;
} });
function setPlacement(key: keyof Placement, value: number | 'cover' | 'contain') { doc.value.placements[selected.value] = { ...placement.value, [key]: value }; }
function move(id: string, delta: number) { doc.value = moveAsset(snapshot(), id, delta); commit(); }
function importing(files: File[], oldId?: string) { void importFiles(files, oldId, replaceAsset); }
function preset(width: number, height: number) { doc.value.width = width; doc.value.height = height; commit(); }
function setDimension(key: 'width' | 'height', value: number) { const ratio = doc.value.width / doc.value.height; const other = key === 'width' ? Math.round(value / ratio) : Math.round(value * ratio); if (lockRatio.value && (other < 64 || other > 8192)) {
    error.value = '锁定比例后的尺寸超出 64–8192 px，请先解锁比例或选择较小尺寸。';
    return;
} if (lockRatio.value)
    doc.value[key === 'width' ? 'height' : 'width'] = other; doc.value[key] = value; }
</script>
<template>
<ToolWorkspace title="图片拼图" :busy="busy" :can-undo="canUndo" :can-redo="canRedo" :has-assets="!!assets.length" :error="error||geometryError" :status="status" @undo="undo" @redo="redo" @reset="reset" @export="exportOpen=!exportOpen" @cancel="cancel" @dismiss="error=''" @drop="importing">
<template #assets>
<AssetList ref="assetList" :assets="assets" :selected="selected" :busy="busy" multiple @import="importing" @remove="remove" @select="selected=$event" @move="move" @clear="clear"/>
</template>
<template #canvas>
<CanvasViewport :has-assets="!!assets.length" :size="size" :logical-size="{width:doc.width,height:doc.height}" :cells="layout" :selected="selected" description="拼图预览；格子选择不改变图片顺序和裁切" @ready="canvas=$event" @select="selected=$event" @import="assetList?.pick()"/>
</template>
<template #properties>
<fieldset :disabled="!assets.length||busy">
<legend>布局</legend>
<label>排列<select v-model="doc.mode" @change="commit">
<option value="grid">网格</option>
<option value="row">横排</option>
<option value="column">竖排</option>
</select>
</label>
<NumberControl v-if="doc.mode==='grid'" label="列数" v-model="doc.columns" :min="1" :max="6" @commit="commit"/>
<p>切换布局保留素材顺序和每张裁切；不满行留空。</p>
<NumberControl label="间距" v-model="doc.gap" :min="0" :max="200" unit="px" @commit="commit"/>
<NumberControl label="外边距" v-model="doc.padding" :min="0" :max="200" unit="px" @commit="commit"/>
<NumberControl label="圆角" v-model="doc.radius" :min="0" :max="100" unit="px" @commit="commit"/>
<ColorControl label="背景颜色" v-model="doc.color" @commit="commit"/>
<label class="check-row">
<input type="checkbox" v-model="doc.transparent" :disabled="doc.format==='image/jpeg'" @change="commit">透明背景（PNG/WebP）</label>
</fieldset>
<fieldset :disabled="!active||busy">
<legend>当前照片构图</legend>
<p>{{active?.file.name||'先选择素材或画布格子'}}</p>
<label>填充方式<select :value="placement.fit" @change="setPlacement('fit',($event.target as HTMLSelectElement).value as 'cover'|'contain');commit()">
<option value="cover">填满并裁切</option>
<option value="contain">完整显示并留白</option>
</select>
</label>
<NumberControl label="水平焦点" :model-value="placement.x" :min="0" :max="100" unit="%" @update:model-value="setPlacement('x',$event)" @commit="commit"/>
<NumberControl label="垂直焦点" :model-value="placement.y" :min="0" :max="100" unit="%" @update:model-value="setPlacement('y',$event)" @commit="commit"/>
<button @click="doc.placements[selected]={x:50,y:50,fit:'cover'};commit()">重置此照片构图</button>
<p>选择、替换、重排、裁切为独立操作；替换保留此格构图设置。</p>
</fieldset>
<fieldset :disabled="busy">
<legend>画布尺寸</legend>
<div class="preset-grid">
<button @click="preset(1080,1080)">方形</button>
<button @click="preset(1920,1080)">横幅</button>
<button @click="preset(1080,1920)">竖幅</button>
</div>
<NumberControl label="宽度" :model-value="doc.width" :min="64" :max="8192" unit="px" @update:model-value="setDimension('width',$event)" @commit="commit"/>
<NumberControl label="高度" :model-value="doc.height" :min="64" :max="8192" unit="px" @update:model-value="setDimension('height',$event)" @commit="commit"/>
<label class="check-row">
<input type="checkbox" v-model="lockRatio">锁定当前宽高比</label>
<p>比例锁定是视图操作，不进入撤销历史。输出最多1600万像素。</p>
</fieldset>
</template>
<template #export>
<ExportPanel :open="exportOpen" :settings="doc" :size="size" :busy="busy" :has-assets="!!assets.length&&!geometryError" :has-result="!!result" :stale="resultRevision!==revision" v-model:filename="filename" @commit="commit" @generate="exportImage" @download="save" @close="exportOpen=false"/>
</template>
</ToolWorkspace>
</template>
