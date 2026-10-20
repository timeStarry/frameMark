// Shared composable for both tools: doc ref, history, preview scheduling,
// export and the leave guard.
import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref, type ShallowRef } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { History } from './engine/history'
import { SerialGate } from './engine/jobs'
import { PreviewCache } from './engine/previewCache'
import { encode, type EncodeSettings } from './engine/encode'
import type { Size } from './engine/limits'

export interface ToolExport {
  blob: Blob
  type: string
  title: string
}

export interface UseTool<D> {
  doc: Ref<D>
  history: History<D>
  preview: ShallowRef<HTMLCanvasElement | null>
  previewCache: PreviewCache
  exporting: Ref<boolean>
  exportError: Ref<string>
  scaleNote: Ref<string>
  sourceIds: Ref<string[]>
  commit(next: D): void
  undo(): void
  redo(): void
  canUndo: Ref<boolean>
  canRedo: Ref<boolean>
  doExport(): Promise<ToolExport | null>
  download(): Promise<void>
}

export function useTool<D extends { format: EncodeSettings['format']; quality: number }>(
  initial: D,
  renderFn: (canvas: HTMLCanvasElement, doc: D, cache: PreviewCache) => Promise<{ fits: boolean }>,
  exportFn: (canvas: HTMLCanvasElement, doc: D) => Promise<{ fits: boolean }>,
  titleFn: (doc: D) => string,
  scaleFn: (doc: D) => { scaledDown: boolean; output: Size },
): UseTool<D> {
  const hist = new History(initial)
  const doc = ref(initial) as Ref<D>
  const canUndo = ref(false)
  const canRedo = ref(false)
  const exporting = ref(false)
  const exportError = ref('')
  const scaleNote = ref('')
  const sourceIds = ref<string[]>([])
  const preview = shallowRef<HTMLCanvasElement | null>(null)
  const cache = new PreviewCache()
  const gate = new SerialGate()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function syncFlags() {
    canUndo.value = hist.past.length > 0
    canRedo.value = hist.future.length > 0
  }

  function commit(next: D) {
    hist.commit(next)
    doc.value = structuredClone(hist.value)
    syncFlags()
  }

  function undo() {
    doc.value = structuredClone(hist.undo())
    syncFlags()
  }

  function redo() {
    doc.value = structuredClone(hist.redo())
    syncFlags()
  }

  function updateScaleNote() {
    const s = scaleFn(doc.value)
    scaleNote.value = s.scaledDown ? `将缩小到 ${s.output.width}×${s.output.height}` : ''
  }

  function schedulePreview() {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      const cv = preview.value
      if (!cv) return
      void gate.run(() => renderFn(cv, doc.value, cache).catch(() => {}))
    }, 150)
  }

  watch(doc, () => {
    updateScaleNote()
    schedulePreview()
  }, { deep: true })

  async function doExport(): Promise<ToolExport | null> {
    exporting.value = true
    exportError.value = ''
    try {
      const cv = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1) as unknown as HTMLCanvasElement
        : document.createElement('canvas')
      const result = await exportFn(cv, doc.value)
      if (!result.fits) {
        exportError.value = '题签放不下，请加宽边框或缩短文字'
        return null
      }
      const blob = await encode(cv, { format: doc.value.format, quality: doc.value.quality })
      return { blob, type: doc.value.format, title: titleFn(doc.value) }
    } catch (e) {
      exportError.value = e instanceof Error ? e.message : '导出失败'
      return null
    } finally {
      exporting.value = false
    }
  }

  async function download() {
    const result = await doExport()
    if (!result) return
    const ext = result.type === 'image/png' ? 'png' : result.type === 'image/webp' ? 'webp' : 'jpg'
    const url = URL.createObjectURL(result.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${result.title}.${ext}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  }

  const dirty = computed(() => JSON.stringify(doc.value) !== JSON.stringify(initial))
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (!dirty.value) return
    e.preventDefault()
    e.returnValue = ''
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  onBeforeRouteLeave(() => !dirty.value || window.confirm('有未导出的修改，确定离开吗？'))
  onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', onBeforeUnload)
    if (debounceTimer) clearTimeout(debounceTimer)
    cache.dispose()
  })

  return {
    doc, history: hist, preview, previewCache: cache, exporting, exportError, scaleNote, sourceIds,
    commit, undo, redo, canUndo, canRedo, doExport, download,
  }
}
