<script setup lang="ts">
// The collage tool (spec §2.2): 2–12 photos, grid/row/column layout.
import { onMounted, reactive, ref, toRaw, watch } from 'vue'
import { usePageHeading } from '../me/pageHeading'
import { collageDefaults, type CollageDoc } from './engine/collageDoc'
import { preflight } from './engine/preflight'
import { decode, type DecodedImage } from './engine/decode'
import { collageTarget, renderCollage } from './engine/render-collage'
import { PreviewCache } from './engine/previewCache'
import { LIMITS, type Size } from './engine/limits'
import { cells } from './engine/geometry'
import { useTool } from './useTool'
import ToolShell from './ToolShell.vue'
import RangeField from './controls/RangeField.vue'
import ColorField from './controls/ColorField.vue'
import ToggleField from './controls/ToggleField.vue'
import SelectField from './controls/SelectField.vue'
import Fieldset from './controls/Fieldset.vue'

const initial = collageDefaults()
const files = reactive<Map<string, File>>(new Map())
const sizes = reactive<Map<string, Size>>(new Map())
const shell = ref<InstanceType<typeof ToolShell> | null>(null)
const heading = ref<HTMLElement | null>(null)
usePageHeading(heading, () => '拼图')

const tool: ReturnType<typeof useTool<CollageDoc>> = useTool<CollageDoc>(
  initial,
  async (canvas, doc, cache) => {
    if (doc.assetIds.length === 0) return { fits: true }
    const bitmaps = new Map<string, CanvasImageSource>()
    for (const id of doc.assetIds) {
      const f = files.get(id)
      if (!f) continue
      bitmaps.set(id, await cache.previewBitmap(id, f))
    }
    const t = collageTarget(doc, LIMITS.previewEdge)
    canvas.width = t.output.width; canvas.height = t.output.height
    renderCollage(canvas.getContext('2d')!, doc, bitmaps, sizes, t.scale)
    return { fits: true }
  },
  async (canvas, doc) => {
    const bitmaps = new Map<string, CanvasImageSource>()
    const decoded: DecodedImage[] = []
    try {
      for (const id of doc.assetIds) {
        const f = files.get(id)
        if (!f) continue
        const bm = await decode(f)
        decoded.push(bm)
        bitmaps.set(id, bm)
      }
      const t = collageTarget(doc)
      canvas.width = t.output.width; canvas.height = t.output.height
      renderCollage(canvas.getContext('2d')!, doc, bitmaps, sizes, t.scale)
      return { fits: true }
    } finally {
      for (const bm of decoded) bm.close()
    }
  },
  () => `拼图 · ${tool.doc.value.assetIds.length} 张`,
  (doc) => collageTarget(doc),
)

const MODE_OPTIONS = [
  { value: 'grid', label: '网格' }, { value: 'row', label: '横排' }, { value: 'column', label: '竖排' },
]
const FORMAT_OPTIONS = [
  { value: 'image/jpeg', label: 'JPEG' }, { value: 'image/png', label: 'PNG' }, { value: 'image/webp', label: 'WebP' },
]
const SIZE_PRESETS = [
  { label: '1:1', w: 1080, h: 1080 }, { label: '4:5', w: 1080, h: 1350 },
  { label: '3:2', w: 1620, h: 1080 }, { label: '16:9', w: 1920, h: 1080 },
]

function update(patch: Partial<CollageDoc>) {
  tool.doc.value = { ...toRaw(tool.doc.value), ...patch }
}

function commitCurrent() {
  tool.commit(toRaw(tool.doc.value))
}

async function addFiles(incoming: FileList | File[]) {
  const d = toRaw(tool.doc.value)
  const ids = [...d.assetIds]
  for (const f of incoming) {
    if (ids.length >= LIMITS.maxAssets) break
    try { await preflight(f) } catch { continue }
    const id = `asset-${Date.now()}-${ids.length}`
    files.set(id, f)
    const info = await preflight(f)
    sizes.set(id, { width: info.width, height: info.height })
    ids.push(id)
  }
  tool.commit({ ...d, assetIds: ids })
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files)
}
function onFileInput(e: Event) {
  const fl = (e.target as HTMLInputElement).files
  if (fl) void addFiles(fl)
}

function removeAsset(id: string) {
  const d = toRaw(tool.doc.value)
  tool.previewCache.evict(id)
  files.delete(id)
  sizes.delete(id)
  tool.commit({ ...d, assetIds: d.assetIds.filter((a: string) => a !== id) })
}

function moveAsset(id: string, delta: number) {
  const d = toRaw(tool.doc.value)
  const i = d.assetIds.indexOf(id)
  if (i < 0) return
  const j = i + delta
  if (j < 0 || j >= d.assetIds.length) return
  const ids = [...d.assetIds]
  ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
  tool.commit({ ...d, assetIds: ids })
}

function onKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey
  if (!mod || e.altKey) return
  const t = e.target
  if (t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'number'))) return
  const k = e.key.toLowerCase()
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); tool.undo() }
  else if ((k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey && !e.metaKey)) { e.preventDefault(); tool.redo() }
}

const d = tool.doc
</script>

<template>
  <div @dragover.prevent @drop="onDrop" @keydown="onKeydown">
    <ToolShell
      ref="shell"
      title="拼图"
      :scale-note="tool.scaleNote.value"
      :exporting="tool.exporting.value"
      :export-error="tool.exportError.value"
      @download="tool.download()"
    >
      <template #controls>
        <div v-if="d.assetIds.length === 0" class="empty">
          <p>选择 2–12 张照片</p>
          <label class="pick">
            选择文件
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple class="sr-only" @change="onFileInput" />
          </label>
        </div>
        <template v-else>
          <div class="asset-list">
            <div v-for="(id, i) in d.assetIds" :key="id" class="asset-row">
              <span class="idx">{{ i + 1 }}</span>
              <button type="button" :disabled="i === 0" :aria-label="`前移第 ${i + 1} 张`" @click="moveAsset(id, -1)">↑</button>
              <button type="button" :disabled="i === d.assetIds.length - 1" :aria-label="`后移第 ${i + 1} 张`" @click="moveAsset(id, 1)">↓</button>
              <button type="button" :aria-label="`移除第 ${i + 1} 张`" @click="removeAsset(id)">✕</button>
            </div>
            <label v-if="d.assetIds.length < 12" class="pick add">
              添加照片
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple class="sr-only" @change="onFileInput" />
            </label>
          </div>

          <Fieldset legend="布局">
            <SelectField label="模式" :model-value="d.mode" :options="MODE_OPTIONS" @update:model-value="v => { update({ mode: v as CollageDoc['mode'] }); commitCurrent() }" />
            <RangeField v-if="d.mode === 'grid'" label="列数" :model-value="d.columns" :min="1" :max="6" :step="1" @update:model-value="(v: number) => update({ columns: v })" @change="commitCurrent" />
            <RangeField label="间距" :model-value="d.gap" :min="0" :max="60" :step="1" suffix="px" @update:model-value="(v: number) => update({ gap: v })" @change="commitCurrent" />
            <RangeField label="外边距" :model-value="d.padding" :min="0" :max="60" :step="1" suffix="px" @update:model-value="(v: number) => update({ padding: v })" @change="commitCurrent" />
            <RangeField label="圆角" :model-value="d.radius" :min="0" :max="30" :step="1" suffix="px" @update:model-value="(v: number) => update({ radius: v })" @change="commitCurrent" />
            <ColorField label="背景" :model-value="d.color" @update:model-value="v => { update({ color: v }); commitCurrent() }" />
            <ToggleField v-if="d.format !== 'image/jpeg'" label="透明背景" :model-value="d.transparent" @update:model-value="v => { update({ transparent: v }); commitCurrent() }" />
          </Fieldset>

          <Fieldset legend="尺寸">
            <div class="size-presets">
              <button v-for="p in SIZE_PRESETS" :key="p.label" type="button" @click="update({ width: p.w, height: p.h }); commitCurrent()">{{ p.label }}</button>
            </div>
            <RangeField label="宽" :model-value="d.width" :min="64" :max="8192" :step="1" suffix="px" @update:model-value="(v: number) => update({ width: v })" @change="commitCurrent" />
            <RangeField label="高" :model-value="d.height" :min="64" :max="8192" :step="1" suffix="px" @update:model-value="(v: number) => update({ height: v })" @change="commitCurrent" />
          </Fieldset>

          <Fieldset legend="导出">
            <SelectField label="格式" :model-value="d.format" :options="FORMAT_OPTIONS" @update:model-value="v => { update({ format: v as CollageDoc['format'] }); commitCurrent() }" />
            <RangeField label="质量" :model-value="d.quality" :min="60" :max="100" :step="1" @update:model-value="(v: number) => update({ quality: v })" @change="commitCurrent" />
            <RangeField label="长边" :model-value="d.longEdge" :min="0" :max="8192" :step="1" @update:model-value="(v: number) => update({ longEdge: v })" @change="commitCurrent" />
            <p class="hint">0 = 自动（不超过 16MP / 8192px）</p>
          </Fieldset>
        </template>
      </template>
    </ToolShell>
  </div>
</template>

<style scoped>
.empty { display: flex; flex-direction: column; align-items: center; gap: var(--space-16); padding: var(--space-48) 0; color: var(--fg-muted); }
.pick { display: inline-flex; align-items: center; min-height: 44px; padding: 0 var(--space-16); border: 1px solid var(--line); color: var(--fg); cursor: pointer; }
.pick:focus-within { outline: 2px solid var(--accent); outline-offset: 4px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); border: 0; }
.asset-list { display: flex; flex-direction: column; gap: var(--space-4); }
.asset-row { display: flex; align-items: center; gap: var(--space-8); min-height: 44px; }
.asset-row button { min-width: 44px; min-height: 44px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; font: inherit; }
.asset-row button:disabled { opacity: 0.35; }
.asset-row button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.idx { min-width: 24px; text-align: center; color: var(--fg-muted); }
.add { margin-top: var(--space-8); }
.size-presets { display: flex; gap: var(--space-8); flex-wrap: wrap; }
.size-presets button { min-height: 44px; padding: 0 var(--space-16); border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; font: inherit; }
.size-presets button:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.hint { margin: 0; color: var(--fg-muted); }
</style>
