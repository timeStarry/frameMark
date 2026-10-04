<script setup lang="ts">
import { computed, ref } from 'vue';
import ToolWorkspace from '../components/ToolWorkspace.vue';
import AssetList from '../components/AssetList.vue';
import CanvasViewport from '../components/CanvasViewport.vue';
import ExportPanel from '../components/ExportPanel.vue';
import NumberControl from '../components/NumberControl.vue';
import ColorControl from '../components/ColorControl.vue';
import { defaults, applyPreset, dimensions, outputSize } from '../core/document';
import { useEditor } from '../core/useEditor';
import { renderDocument } from '../engine/pipeline';
import { fields } from '../engine/assets';
const { doc, assets, canvas, selected, error, status, busy, revision, exportOpen, result, resultRevision, filename, canUndo, canRedo, size, snapshot, commit, undo, redo, reset, remove, cancel, importFiles, exportImage, save } = useEditor(defaults, renderDocument, (d, map) => { const a = map.get(d.assetIds[0] || ''); return a ? outputSize(dimensions(d, a), d.longEdge) : null; }, 1);
filename.value = 'markr-watermark';
const asset = computed(() => assets.value[0]), assetList = ref<InstanceType<typeof AssetList>>();
function preset(name: string) { doc.value = applyPreset(snapshot(), name); commit(); }
</script>
<template>
<ToolWorkspace title="边框水印" :busy="busy" :can-undo="canUndo" :can-redo="canRedo" :has-assets="!!asset" :error="error" :status="status" @undo="undo" @redo="redo" @reset="reset" @export="exportOpen=!exportOpen" @cancel="cancel" @dismiss="error=''" @drop="files=>importFiles(files,asset?.id)">
<template #assets>
<AssetList ref="assetList" :assets="assets" :selected="selected" :busy="busy" @import="importFiles" @remove="remove" @select="selected=$event"/>
</template>
<template #canvas>
<CanvasViewport :busy="busy" :transparent="doc.transparent&&doc.format!=='image/jpeg'&&doc.frame==='solid'" :has-assets="!!asset" :size="size" description="边框与文字的本地预览" @ready="canvas=$event" @import="assetList?.pick()"/>
</template>
<template #properties>
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
<ColorControl label="背景颜色" v-model="doc.color" @commit="commit"/>
<label v-if="doc.format!=='image/jpeg'&&doc.frame==='solid'" class="check-row">
<input type="checkbox" v-model="doc.transparent" @change="commit">透明边框</label>
<ColorControl v-if="doc.frame==='gradient'" label="第二颜色" v-model="doc.secondColor" @commit="commit"/>
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
<ColorControl label="文字颜色" v-model="doc.textColor" @commit="commit"/>
<label>位置<select v-model="doc.position" @change="commit">
<option v-for="(name,i) in ['左上','上中','右上','左中','中心','右中','左下','下中','右下']" :key="i" :value="i">{{name}}</option>
</select>
</label>
</fieldset>
<details class="inspector-details">
<summary>拍摄参数</summary>
<fieldset :disabled="!asset||busy">
<legend class="sr-only">拍摄参数（可选）</legend>
<p>不读取位置；导出不复制原始元数据。</p>
<label v-for="(name,key) in fields" :key="key" class="check-row">
<input type="checkbox" :value="key" v-model="doc.fields" :disabled="!asset?.metadata[key]" @change="commit">{{name}} <small>{{asset?.metadata[key]||'无信息'}}</small>
</label>
<label v-for="key in doc.fields" :key="'edit-'+key">{{fields[key]}}显示值<input :value="doc.fieldValues[key]||asset?.metadata[key]" maxlength="100" @change="doc.fieldValues[key]=($event.target as HTMLInputElement).value;commit()">
</label>
</fieldset>
</details>
</template>
<template #export>
<ExportPanel :open="exportOpen" :settings="doc" :size="size" :busy="busy" :has-assets="!!asset" :has-result="!!result" :stale="resultRevision!==revision" v-model:filename="filename" watermark @commit="commit" @generate="exportImage" @download="save" @close="exportOpen=false"/>
</template>
</ToolWorkspace>
</template>
