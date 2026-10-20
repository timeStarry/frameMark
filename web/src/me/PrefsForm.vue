<script setup lang="ts">
// 上传偏好 (SP4a spec §8, parent §5.1). An explicit-save form over
// GET/PUT /api/upload-prefs. Emits `dirty` whenever the draft differs from
// the last loaded or saved value; the route owns the leave guard.
import { computed, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue'
import { getPrefs, putPrefs } from '../api/me'
import type { UploadPrefs, Watermark } from '../api/types'
import WallStatus from '../walls/WallStatus.vue'

const emit = defineEmits<{ dirty: [boolean] }>()

type Payload = Omit<UploadPrefs, 'updatedAt'>
type Position = Watermark['position']

// Order and keys match internal/domain PublicFieldKeys.
const FIELDS: { key: string; label: string }[] = [
  { key: 'camera', label: '机身' },
  { key: 'lens', label: '镜头' },
  { key: 'focal_length', label: '焦段' },
  { key: 'aperture', label: '光圈' },
  { key: 'shutter', label: '快门' },
  { key: 'iso', label: 'ISO' },
  { key: 'exposure_bias', label: '曝光补偿' },
  { key: 'taken_date', label: '拍摄日期' },
]
const POSITIONS: { value: Position; label: string }[] = [
  { value: 'br', label: '右下' },
  { value: 'bl', label: '左下' },
  { value: 'tr', label: '右上' },
  { value: 'tl', label: '左上' },
  { value: 'center', label: '居中' },
]
const LICENSES = ['by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd']
const licenseLabel = (c: string) => `CC ${c.toUpperCase()}`
// internal/media/watermark.go: 1–64 runes with at least one visible glyph.
const MAX_WM_RUNES = 64
const WM_MESSAGE = '水印文字需为 1–64 个字符。'

const id = useId()
const headingId = `${id}-title`

interface Draft {
  fields: string[]
  histogramPublic: boolean
  originalDownload: boolean
  wmMode: 'off' | 'text'
  wmText: string
  wmPosition: Position
  wmOpacity: number
  wmScale: number
  license: string
  ai: string
  locationMode: 'off' | 'archive'
}

const draft = reactive<Draft>({
  fields: [],
  histogramPublic: false,
  originalDownload: false,
  wmMode: 'off',
  wmText: '',
  wmPosition: 'br',
  wmOpacity: 0.5,
  wmScale: 0.04,
  license: '',
  ai: '',
  locationMode: 'off',
})

function fill(p: UploadPrefs): void {
  draft.fields = FIELDS.map((f) => f.key).filter((k) => p.publicFields.includes(k))
  draft.histogramPublic = p.histogramPublic
  draft.originalDownload = p.originalDownload
  draft.wmMode = p.watermark ? 'text' : 'off'
  // Keep the last watermark values so toggling 关闭/文字 does not lose them.
  if (p.watermark) {
    draft.wmText = p.watermark.text
    draft.wmPosition = p.watermark.position
    draft.wmOpacity = p.watermark.opacity
    draft.wmScale = p.watermark.scale
  }
  draft.license = p.defaultLicense ?? ''
  draft.ai = p.defaultAiDeclaration ?? ''
  draft.locationMode = p.locationMode
}

function payload(): Payload {
  return {
    publicFields: FIELDS.map((f) => f.key).filter((k) => draft.fields.includes(k)),
    histogramPublic: draft.histogramPublic,
    originalDownload: draft.originalDownload,
    watermark:
      draft.wmMode === 'text'
        ? { text: draft.wmText, position: draft.wmPosition, opacity: draft.wmOpacity, scale: draft.wmScale }
        : null,
    defaultLicense: draft.license === '' ? null : draft.license,
    defaultAiDeclaration: draft.ai === '' ? null : draft.ai,
    locationMode: draft.locationMode,
  }
}

const state = ref<'loading' | 'error' | 'idle'>('loading')
// JSON of the last loaded or saved payload; key order is fixed by payload().
const baseline = ref<string | null>(null)
const current = computed(() => JSON.stringify(payload()))
const dirty = computed(() => baseline.value !== null && current.value !== baseline.value)
const busy = ref(false)
const saved = ref(false)
const error = ref('')

watch(dirty, (v) => emit('dirty', v), { immediate: true })
// Only a real edit clears 已保存; adopting the server's reply does not.
watch(current, () => {
  if (dirty.value) saved.value = false
})

const opacityText = computed(() => `${Math.round(draft.wmOpacity * 100)}%`)
const scaleText = computed(() => `${(draft.wmScale * 100).toFixed(1)}%`)

let ctrl: AbortController | null = null

function adopt(p: UploadPrefs): void {
  fill(p)
  baseline.value = JSON.stringify(payload())
}

async function load(): Promise<void> {
  ctrl?.abort()
  const c = new AbortController()
  ctrl = c
  state.value = 'loading'
  const r = await getPrefs(c.signal)
  if (ctrl !== c) return
  if (r.ok) {
    adopt(r.data)
    state.value = 'idle'
    return
  }
  if (r.status === -1) return
  state.value = 'error'
}

function validWatermarkText(t: string): boolean {
  const n = [...t].length
  return n >= 1 && n <= MAX_WM_RUNES && t.trim() !== ''
}

async function onSubmit(): Promise<void> {
  if (busy.value || !dirty.value) return
  error.value = ''
  const p = payload()
  if (p.watermark && !validWatermarkText(p.watermark.text)) {
    error.value = WM_MESSAGE
    return
  }
  busy.value = true
  const r = await putPrefs(p)
  busy.value = false
  if (r.ok) {
    adopt(r.data)
    saved.value = true
    return
  }
  if (r.status !== -1) error.value = r.message
}

onMounted(() => void load())
onBeforeUnmount(() => {
  ctrl?.abort()
  ctrl = null
})
</script>

<template>
  <form class="settings-form" :aria-labelledby="headingId" novalidate @submit.prevent="onSubmit">
    <h2 :id="headingId">上传偏好</h2>
    <p class="lead">修改只影响之后上传的照片。已上传的照片在合集中逐张调整。</p>
    <template v-if="state === 'idle'">
      <fieldset>
        <legend>公开参数字段</legend>
        <div class="checks">
          <label v-for="f in FIELDS" :key="f.key" class="check">
            <input v-model="draft.fields" type="checkbox" :value="f.key" />
            {{ f.label }}
          </label>
        </div>
      </fieldset>

      <div class="switches">
        <label class="check">
          <input v-model="draft.histogramPublic" type="checkbox" role="switch" />
          直方图默认公开
        </label>
        <label class="check">
          <input v-model="draft.originalDownload" type="checkbox" role="switch" />
          原图下载默认开启
        </label>
      </div>

      <fieldset>
        <legend>下载档水印</legend>
        <div class="radios">
          <label class="check">
            <input v-model="draft.wmMode" type="radio" :name="`${id}-wm`" value="off" />
            关闭
          </label>
          <label class="check">
            <input v-model="draft.wmMode" type="radio" :name="`${id}-wm`" value="text" />
            文字
          </label>
        </div>
        <div v-if="draft.wmMode === 'text'" class="watermark">
          <div class="field">
            <label :for="`${id}-wm-text`">水印文字</label>
            <input
              :id="`${id}-wm-text`"
              v-model="draft.wmText"
              type="text"
              autocomplete="off"
              :aria-describedby="`${id}-wm-hint`"
            />
            <span :id="`${id}-wm-hint`" class="hint">最多 64 个字符</span>
          </div>
          <div class="field">
            <label :for="`${id}-wm-pos`">位置</label>
            <select :id="`${id}-wm-pos`" v-model="draft.wmPosition">
              <option v-for="p in POSITIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
          </div>
          <div class="field">
            <label :for="`${id}-wm-opacity`">不透明度</label>
            <div class="range">
              <input
                :id="`${id}-wm-opacity`"
                v-model.number="draft.wmOpacity"
                type="range"
                min="0.1"
                max="0.8"
                step="0.05"
                :aria-valuetext="opacityText"
              />
              <output :for="`${id}-wm-opacity`">{{ opacityText }}</output>
            </div>
          </div>
          <div class="field">
            <label :for="`${id}-wm-scale`">大小</label>
            <div class="range">
              <input
                :id="`${id}-wm-scale`"
                v-model.number="draft.wmScale"
                type="range"
                min="0.02"
                max="0.08"
                step="0.005"
                :aria-valuetext="scaleText"
              />
              <output :for="`${id}-wm-scale`">{{ scaleText }}</output>
            </div>
          </div>
        </div>
      </fieldset>

      <div class="field">
        <label :for="`${id}-license`">默认许可</label>
        <select :id="`${id}-license`" v-model="draft.license">
          <option value="">无</option>
          <option v-for="c in LICENSES" :key="c" :value="c">{{ licenseLabel(c) }}</option>
        </select>
      </div>

      <fieldset>
        <legend>AI 声明</legend>
        <div class="radios">
          <label class="check">
            <input v-model="draft.ai" type="radio" :name="`${id}-ai`" value="" />
            无
          </label>
          <label class="check">
            <input v-model="draft.ai" type="radio" :name="`${id}-ai`" value="no-generative-ai" />
            未使用生成式 AI
          </label>
        </div>
      </fieldset>

      <fieldset :aria-describedby="`${id}-loc-note`">
        <legend>位置信息</legend>
        <div class="radios">
          <label class="check">
            <input v-model="draft.locationMode" type="radio" :name="`${id}-loc`" value="off" />
            不提取
          </label>
          <label class="check">
            <input v-model="draft.locationMode" type="radio" :name="`${id}-loc`" value="archive" />
            仅自己的归档可见
          </label>
        </div>
        <p :id="`${id}-loc-note`" class="hint">位置信息永远不会公开。</p>
      </fieldset>

      <div class="actions">
        <button type="submit" :disabled="!dirty || busy" :aria-busy="busy ? 'true' : undefined">保存</button>
        <p class="status" role="status">{{ saved ? '已保存' : '' }}</p>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </template>
    <WallStatus v-else :state="state" @retry="load" />
  </form>
</template>


<style scoped src="./settingsForm.css"></style>
