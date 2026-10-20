<script setup lang="ts">
// The frame tool (spec §2.1): single photo, border, caption, EXIF fields.
import { onMounted, reactive, ref, toRaw, watch } from 'vue'
import { usePageHeading } from '../me/pageHeading'
import { defaultsFrame, applyPreset, cleanText, MAX_CAPTION, type FrameDoc, type PresetName, FRAME_PRESETS } from './engine/frameDoc'
import { parseExif, fields as exifFields, mapExif } from './engine/exif'
import { preflight } from './engine/preflight'
import type { OwnerPhoto } from '../api/types'
import { decode, type DecodedImage } from './engine/decode'
import { frameTarget, renderFrame, photoRect } from './engine/render-frame'
import { PreviewCache } from './engine/previewCache'
import { LIMITS } from './engine/limits'
import { useTool } from './useTool'
import { session } from '../api/session'
import ArchivePicker from './ArchivePicker.vue'
import SaveToArchive from './SaveToArchive.vue'
import ToolShell from './ToolShell.vue'
import RangeField from './controls/RangeField.vue'
import TextField from './controls/TextField.vue'
import ColorField from './controls/ColorField.vue'
import ToggleField from './controls/ToggleField.vue'
import PositionField from './controls/PositionField.vue'
import SelectField from './controls/SelectField.vue'
import Fieldset from './controls/Fieldset.vue'

const initial = defaultsFrame()
const sourceSize = reactive({ width: 0, height: 0 })
const file = ref<File | null>(null)
const metadata = ref<Record<string, string>>({})
const shell = ref<InstanceType<typeof ToolShell> | null>(null)
const heading = ref<HTMLElement | null>(null)
usePageHeading(heading, () => '边框')

const tool = useTool<FrameDoc>(
  initial,
  async (canvas, doc, cache) => {
    if (!file.value || !doc.assetId) return { fits: true }
    const bitmap = await cache.previewBitmap(doc.assetId, file.value)
    const t = frameTarget(doc, sourceSize, LIMITS.previewEdge)
    canvas.width = t.output.width; canvas.height = t.output.height
    return renderFrame(canvas.getContext('2d')!, doc, bitmap, sourceSize, t.scale, metadata.value)
  },
  async (canvas, doc) => {
    if (!file.value) return { fits: true }
    const bitmap = await decode(file.value)
    try {
      const t = frameTarget(doc, sourceSize)
      canvas.width = t.output.width; canvas.height = t.output.height
      return renderFrame(canvas.getContext('2d')!, doc, bitmap, sourceSize, t.scale, metadata.value)
    } finally { bitmap.close() }
  },
  () => file.value?.name?.replace(/\.[^.]+$/, '') ?? '边框',
  (doc) => frameTarget(doc, sourceSize.width > 0 ? sourceSize : { width: 1, height: 1 }),
)

const PRESETS: { name: PresetName; label: string }[] = [
  { name: 'light', label: '浅色' }, { name: 'dark', label: '深色' },
  { name: 'soft', label: '柔和' }, { name: 'caption', label: '底条' },
]
const FRAME_OPTIONS = [
  { value: 'solid', label: '纯色' }, { value: 'gradient', label: '渐变' },
  { value: 'blur', label: '模糊' }, { value: 'bottom-bar', label: '底条' },
]
const FORMAT_OPTIONS = [
  { value: 'image/jpeg', label: 'JPEG' }, { value: 'image/png', label: 'PNG' }, { value: 'image/webp', label: 'WebP' },
]
const FONT_OPTIONS = [
  { value: 'sans-serif', label: '无衬线' }, { value: 'serif', label: '衬线' }, { value: 'monospace', label: '等宽' },
]

function setPreset(name: PresetName) {
  tool.commit(applyPreset(toRaw(tool.doc.value), name))
}

function update(patch: Partial<FrameDoc>) {
  tool.doc.value = { ...toRaw(tool.doc.value), ...patch }
}

function commitCurrent() {
  tool.commit(toRaw(tool.doc.value))
}

async function addFile(f: File) {
  try { await preflight(f) } catch (e) { alert(e instanceof Error ? e.message : '无法读取此文件'); return }
  const id = `asset-${Date.now()}`
  file.value = f
  metadata.value = mapExif(await parseExif(f).catch(() => null) as Record<string, unknown> | null)
  const info = await preflight(f)
  sourceSize.width = info.width; sourceSize.height = info.height
  tool.previewCache.evict(tool.doc.value.assetId ?? '')
  tool.commit({ ...toRaw(tool.doc.value), assetId: id, fields: [], fieldValues: {} })
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  const f = e.dataTransfer?.files[0]
  if (f) void addFile(f)
}
function onFileInput(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) void addFile(f)
}

onMounted(() => {
  const h = shell.value?.canvas ? null : null
  void h
})

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
const picking = ref(false)
const saving = ref(false)
const savedBlob = ref<Blob | null>(null)
const savedTitle = ref('')

async function onPick(photos: OwnerPhoto[]) {
  picking.value = false
  for (const ph of photos) {
    // Fetch the original through the owner source endpoint.
    try {
      const r = await fetch(`/api/photos/${encodeURIComponent(ph.id)}/source`, { credentials: 'same-origin', redirect: 'follow' })
      if (!r.ok) continue
      const blob = await r.blob()
      const f = new File([blob], ph.title || 'archive.jpg', { type: blob.type || 'image/jpeg' })
      tool.sourceIds.value = [...tool.sourceIds.value, ph.id]
      void addFile(f)
    } catch { continue }
  }
}

function exportAndSave() {
  void tool.doExport().then(r => {
    if (!r) return
    savedBlob.value = r.blob
    savedTitle.value = tool.exportError.value ? '' : '成品'
    saving.value = true
  })
}
</script>

<template>
  <div @dragover.prevent @drop="onDrop" @keydown="onKeydown">
    <ToolShell
      ref="shell"
      title="边框"
      :scale-note="tool.scaleNote.value"
      :exporting="tool.exporting.value"
      :export-error="tool.exportError.value"
      @download="tool.download()"
    >
      <template #controls>
        <div v-if="!d.assetId" class="empty">
          <p>选择一张照片开始</p>
          <label class="pick">
            选择文件
            <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" @change="onFileInput" />
          </label>
        </div>
        <template v-else>
          <div class="presets">
            <button v-for="p in PRESETS" :key="p.name" type="button" @click="setPreset(p.name)">{{ p.label }}</button>
          </div>
          <SelectField label="边框样式" :model-value="d.frame" :options="FRAME_OPTIONS" @update:model-value="v => { update({ frame: v as FrameDoc['frame'] }); commitCurrent() }" />
          <RangeField label="边框宽度" :model-value="d.border" :min="0" :max="20" :step="1" suffix="%" @update:model-value="v => update({ border: v })" @change="commitCurrent" />
          <RangeField v-if="d.frame === 'bottom-bar'" label="底条高度" :model-value="d.bottom" :min="5" :max="40" :step="1" suffix="%" @update:model-value="v => update({ bottom: v })" @change="commitCurrent" />
          <RangeField label="圆角" :model-value="d.radius" :min="0" :max="10" :step="0.5" suffix="%" @update:model-value="v => update({ radius: v })" @change="commitCurrent" />
          <ColorField label="颜色" :model-value="d.color" @update:model-value="v => { update({ color: v }); commitCurrent() }" />
          <ColorField v-if="d.frame === 'gradient'" label="渐变色" :model-value="d.secondColor" @update:model-value="v => { update({ secondColor: v }); commitCurrent() }" />
          <RangeField v-if="d.frame === 'blur'" label="模糊半径" :model-value="d.blur" :min="0.5" :max="5" :step="0.1" suffix="%" @update:model-value="v => update({ blur: v })" @change="commitCurrent" />

          <Fieldset legend="题签">
            <TextField label="文字" :model-value="d.text" :max-length="MAX_CAPTION" counter @update:model-value="v => update({ text: cleanText(v) })" @blur="commitCurrent" />
            <SelectField label="字体" :model-value="d.font" :options="FONT_OPTIONS" @update:model-value="v => { update({ font: v as FrameDoc['font'] }); commitCurrent() }" />
            <RangeField label="字号" :model-value="d.size" :min="0.5" :max="8" :step="0.1" suffix="%" @update:model-value="v => update({ size: v })" @change="commitCurrent" />
            <RangeField label="不透明度" :model-value="d.opacity" :min="0" :max="1" :step="0.05" @update:model-value="v => update({ opacity: v })" @change="commitCurrent" />
            <ColorField label="文字颜色" :model-value="d.textColor" @update:model-value="v => { update({ textColor: v }); commitCurrent() }" />
            <PositionField label="位置" :model-value="d.position" @update:model-value="v => { update({ position: v }); commitCurrent() }" />
          </Fieldset>

          <Fieldset legend="拍摄参数">
            <label v-for="(label, key) in exifFields" :key="key" class="exif-row">
              <input type="checkbox" :checked="d.fields.includes(key)" @change="e => {
                const on = (e.target as HTMLInputElement).checked
                const fields = on ? [...d.fields, key] : d.fields.filter(k => k !== key)
                const fieldValues = on && metadata[key] ? { ...d.fieldValues, [key]: metadata[key] } : d.fieldValues
                update({ fields, fieldValues }); commitCurrent()
              }" />
              <span class="label">{{ label }}</span>
              <input
                v-if="d.fields.includes(key)"
                type="text"
                class="field-val"
                :value="d.fieldValues[key] ?? metadata[key] ?? ''"
                @input="e => update({ fieldValues: { ...d.fieldValues, [key]: (e.target as HTMLInputElement).value } })"
                @blur="commitCurrent"
              />
            </label>
          </Fieldset>

          <Fieldset legend="导出">
            <SelectField label="格式" :model-value="d.format" :options="FORMAT_OPTIONS" @update:model-value="v => { update({ format: v as FrameDoc['format'] }); commitCurrent() }" />
            <RangeField label="质量" :model-value="d.quality" :min="60" :max="100" :step="1" @update:model-value="v => update({ quality: v })" @change="commitCurrent" />
            <RangeField label="长边" :model-value="d.longEdge" :min="0" :max="8192" :step="1" @update:model-value="v => update({ longEdge: v })" @change="commitCurrent" />
            <p class="hint">0 = 自动（不超过 16MP / 8192px）</p>
          </Fieldset>

          <ToggleField v-if="d.format !== 'image/jpeg'" label="透明背景" :model-value="d.transparent" @update:model-value="v => { update({ transparent: v }); commitCurrent() }" />

          <label class="pick replace">
            更换照片
            <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" @change="onFileInput" />
          </label>
        </template>
        <button v-if="session.user" type="button" @click="exportAndSave">存入归档</button>
        <button v-if="session.user" type="button" @click="picking = !picking">{{ picking ? '收起归档' : '从归档选' }}</button>
      </template>
    </ToolShell>
    <ArchivePicker v-if="picking" :max-pick="1" @pick="onPick" />
    <SaveToArchive v-if="saving && savedBlob" :blob="savedBlob" :default-title="savedTitle" :source-ids="tool.sourceIds.value" @close="saving = false" @done="saving = false" />
  </div>
</template>

<style scoped>
.empty { display: flex; flex-direction: column; align-items: center; gap: var(--space-16); padding: var(--space-48) 0; color: var(--fg-muted); }
.pick { display: inline-flex; align-items: center; min-height: 44px; padding: 0 var(--space-16); border: 1px solid var(--line); color: var(--fg); cursor: pointer; }
.pick:focus-within { outline: 2px solid var(--accent); outline-offset: 4px; }
.replace { margin-top: var(--space-16); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); border: 0; }
.presets { display: flex; gap: var(--space-8); flex-wrap: wrap; }
.presets button { min-height: 44px; padding: 0 var(--space-16); border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; font: inherit; }
.presets button:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.exif-row { display: flex; align-items: center; gap: var(--space-8); min-height: 44px; }
.exif-row input[type="checkbox"] { width: 20px; height: 20px; accent-color: var(--accent); }
.exif-row .label { min-width: 48px; color: var(--fg-muted); }
.field-val { flex: 1; min-height: 36px; padding: 0 var(--space-8); border: 1px solid var(--line); background: var(--bg-wall); color: var(--fg); font: inherit; }
.field-val:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hint { margin: 0; color: var(--fg-muted); }
</style>
