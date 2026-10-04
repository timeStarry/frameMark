<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import type { Size } from '../core/document';
import type { Cell } from '../core/collage';
const props = defineProps<{
    hasAssets: boolean;
    busy?: boolean;
    transparent?: boolean;
    size: Size | null;
    description: string;
    cells?: Cell[];
    logicalSize?: Size;
    selected?: string;
}>(), emit = defineEmits<{
    ready: [
        canvas: HTMLCanvasElement
    ];
    select: [
        id: string
    ];
    import: [
    ];
}>(), canvas = ref<HTMLCanvasElement>(), viewport = ref<HTMLElement>(), zoom = ref('fit'), width = ref(320), height = ref(360);
let observer: ResizeObserver | undefined;
const stageWidth = computed(() => { if (!props.size)
    return 0; const ratio = props.size.width / props.size.height; return zoom.value === 'fit' ? Math.max(1, Math.min(width.value - 40, (height.value - 40) * ratio)) : props.size.width * Number(zoom.value); });
watch(canvas, value => { if (value)
    emit("ready", value); }, { flush: "post" });
onMounted(() => { if (canvas.value)
    emit('ready', canvas.value); if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(([entry]) => { if (entry) {
        width.value = entry.contentRect.width;
        height.value = entry.contentRect.height;
    } });
    if (viewport.value)
        observer.observe(viewport.value);
} });
onUnmounted(() => observer?.disconnect());
watch(() => [props.size?.width, props.size?.height], () => zoom.value = 'fit');
</script>
<template>
<div ref="viewport" class="canvas-viewport">
<div v-if="hasAssets&&size" class="canvas-stage" :class="{'transparent-output':transparent}" :style="{width:stageWidth+'px',aspectRatio:size.width+'/'+size.height}">
<canvas ref="canvas" role="img" :aria-label="description">
</canvas>
<button v-for="cell in cells||[]" :key="cell.id" class="cell-hit" :class="{selected:cell.id===selected}" :aria-label="'选择第 '+((cells||[]).indexOf(cell)+1)+' 格照片'" :aria-pressed="cell.id===selected" :style="{left:cell.x/(logicalSize?.width||1)*100+'%',top:cell.y/(logicalSize?.height||1)*100+'%',width:cell.width/(logicalSize?.width||1)*100+'%',height:cell.height/(logicalSize?.height||1)*100+'%'}" @click="emit('select',cell.id)">
</button>
</div>
<div v-else class="editor-empty">
<canvas ref="canvas" hidden>
</canvas>
<p>拖入照片，或选择本地文件。</p>
<button :disabled="busy" @click="emit('import')">选择照片</button>
</div>
</div>
<div class="canvas-status">
<span>{{hasAssets&&size?`预览 · ${size.width} × ${size.height} px`:'预览'}}</span>
<label>缩放 <select v-model="zoom" :disabled="!hasAssets">
<option value="fit">适应</option>
<option value="0.25">25%</option>
<option value="0.5">50%</option>
<option value="1">100%</option>
<option value="2">200%</option>
</select>
</label>
</div>
</template>
