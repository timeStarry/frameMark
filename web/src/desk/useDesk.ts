// useDesk.ts — the curation desk's reactive state (spec §4.5, §4.6, §6).
// Wires the sequence model, undo history, save lanes, local backup, the
// exposure-check confirmation for published collections, and 409 handling.
import { computed, getCurrentScope, onScopeDispose, reactive, ref, watch, type ComputedRef, type Ref } from 'vue'
import {
  deleteCollection,
  exposureCheck,
  getOwnerCollection,
  publish as publishCollection,
  publishDryRun,
  putCollection,
  putFrames,
  putOverride,
  putPhotoMeta,
  unpublish as unpublishCollection,
} from '../api/desk'
import type {
  Collection,
  CollectionFields,
  ExposureChange,
  ExposureCheckInput,
  FrameInput,
  Manifest,
  OverrideInput,
  OwnerCollection,
  OwnerCollectionWrite,
  OwnerFramePhoto,
} from '../api/types'
import { clearBackup, loadBackup, saveBackup, type Backup } from './backup'
import { createHistory } from './history'
import { toPreview, type PhotoDetail } from './preview'
import { createLane, type Lane, type SendResult } from './saveQueue'
import { fromOwner, isValid, photoIds, toInput, type Seq } from './sequence'

export type DeskState = 'loading' | 'error' | 'ready' | 'missing'
export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error' | 'conflict'

export interface ExposureDialog {
  open: boolean
  changes: ExposureChange[]
  confirm(): void
  cancel(): void
}

export interface ConflictDialog {
  reload(): Promise<void>
  overwrite(): Promise<void>
}

export interface BackupOffer {
  restore(): void
  discard(): void
}

export interface PhotoMeta {
  title: string
  caption: string
}

export interface Desk {
  state: ComputedRef<DeskState>
  collection: ComputedRef<OwnerCollection | null>
  fields: ComputedRef<CollectionFields>
  seq: ComputedRef<Seq>
  selected: Ref<number>
  saveState: ComputedRef<SaveState>
  errorMessage: ComputedRef<string>
  exposure: ComputedRef<ExposureDialog | null>
  conflict: ComputedRef<ConflictDialog | null>
  backupOffer: ComputedRef<BackupOffer | null>
  previewCollection: ComputedRef<Collection | null>
  canUndo: ComputedRef<boolean>
  canRedo: ComputedRef<boolean>
  applySeq(next: Seq, kind: 'structure'): void
  applyFields(next: CollectionFields, kind: 'field' | 'exposure'): void
  setPhotoMeta(photoId: string, m: PhotoMeta): void
  setOverride(photoId: string, o: OverrideInput): void
  undo(): void
  redo(): void
  publish(): Promise<Manifest | null>
  confirmPublish(): Promise<boolean>
  unpublish(): Promise<boolean>
  remove(): Promise<boolean>
  dispose(): void
}

const FALLBACK = '保存失败，请重试'

const VALID_REASONS: Record<string, string> = {
  'text frame is empty': '文字页不能为空',
  'pair needs 2 to 3 photos': '并置页需要 2 到 3 张照片',
  'pair photos must differ': '并置页的照片不能重复',
}

function chineseReason(index: number, reason: string): string {
  let msg = VALID_REASONS[reason]
  if (!msg) {
    if (reason.startsWith('a collection holds at most')) msg = '合集最多 200 帧'
    else if (reason.startsWith('text is longer than')) msg = '文字超过 2000 字'
    else if (reason === 'text frame cannot hold photos') msg = '文字页不能放照片'
    else if (reason.endsWith('frame needs exactly 1 photo')) msg = reason.startsWith('matted') ? '卡纸页需要恰好 1 张照片' : '整页需要恰好 1 张照片'
    else if (reason === 'matte ratio must be 0.5 to 0.95') msg = '卡纸比例须在 0.5 到 0.95 之间'
    else msg = reason
  }
  return `第 ${index + 1} 帧：${msg}`
}

function pickFields(c: OwnerCollection): CollectionFields {
  return {
    title: c.title,
    intro: c.intro,
    visibility: c.visibility,
    distribute: c.distribute,
    originalDownload: c.originalDownload,
    license: c.license,
    aiDeclaration: c.aiDeclaration,
    coverPhotoId: c.coverPhotoId ?? c.cover?.id ?? null,
  }
}

function cloneFields(f: CollectionFields): CollectionFields {
  return { ...f }
}

function sameFields(a: CollectionFields, b: CollectionFields): boolean {
  return (
    a.title === b.title &&
    a.intro === b.intro &&
    a.visibility === b.visibility &&
    a.distribute === b.distribute &&
    a.originalDownload === b.originalDownload &&
    a.license === b.license &&
    a.aiDeclaration === b.aiDeclaration &&
    a.coverPhotoId === b.coverPhotoId
  )
}

function sameFrames(a: FrameInput[], b: FrameInput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function photoDetail(p: OwnerFramePhoto): PhotoDetail {
  return {
    title: p.title,
    caption: p.caption,
    exif: p.exif,
    histogram: p.histogram,
    attribution: p.attribution,
    publicFields: p.publicFields,
    histogramPublic: p.histogramPublic,
  }
}

function detailsFrom(c: OwnerCollection): Record<string, PhotoDetail> {
  const out: Record<string, PhotoDetail> = {}
  for (const f of c.frames) for (const p of f.photos) out[p.id] = photoDetail(p)
  if (c.cover) out[c.cover.id] = photoDetail(c.cover)
  return out
}

function applyWrite(c: OwnerCollection, w: OwnerCollectionWrite): OwnerCollection {
  return {
    ...c,
    title: w.title,
    intro: w.intro,
    status: w.status,
    visibility: w.visibility,
    distribute: w.distribute,
    originalDownload: w.originalDownload,
    license: w.license,
    aiDeclaration: w.aiDeclaration,
    coverPhotoId: w.coverPhotoId,
    publishedAt: w.publishedAt,
    updatedAt: w.updatedAt,
  }
}

type PendingExposure =
  | { kind: 'frames'; next: Seq; prev: Seq }
  | { kind: 'fields'; next: CollectionFields; prev: CollectionFields }
  | { kind: 'override'; photoId: string; next: OverrideInput; prev: OverrideInput }

/**
 * Addendum rule 3: a structural edit that only removes, reorders or restyles
 * frames narrows and skips the check. Adding a photo, a merge (same photos in
 * fewer frames) or a split (same photos in more frames) is checked. Removing a
 * text frame looks like a merge here and is checked too, which is conservative.
 */
function mayWidenFrames(prev: Seq, next: Seq): boolean {
  const before = photoIds(prev)
  const after = photoIds(next)
  for (const id of after) if (!before.has(id)) return true
  if (next.length === prev.length) return false
  return after.size === before.size
}

function fieldsMayWiden(prev: CollectionFields, next: CollectionFields): boolean {
  return prev.visibility !== next.visibility || prev.distribute !== next.distribute || prev.originalDownload !== next.originalDownload
}

export function useDesk(id: Ref<string>): Desk {
  const state = ref<DeskState>('loading')
  const collection = ref<OwnerCollection | null>(null)
  const fields = ref<CollectionFields>({
    title: '',
    intro: '',
    visibility: 'private',
    distribute: false,
    originalDownload: false,
    license: null,
    aiDeclaration: null,
    coverPhotoId: null,
  })
  const seq = ref<Seq>([])
  const selected = ref(0)
  const errorMessage = ref('')
  const updatedAt = ref(0)
  const photos = reactive<Record<string, PhotoDetail>>({})
  const overrides = reactive<Record<string, OverrideInput>>({})
  const canUndo = ref(false)
  const canRedo = ref(false)

  const history = createHistory<Seq>([])
  const forceWrite = ref(false)
  const conflictOpen = ref(false)
  const backupOfferOpen = ref(false)
  let storedBackup: Backup<CollectionFields, FrameInput[]> | null = null

  const exposureOpen = ref(false)
  const exposureChanges = ref<ExposureChange[]>([])
  let pendingExposure: PendingExposure | null = null
  let checking = false
  /** The latest structural edit made while a check or dialog was open. */
  let queuedSeq: Seq | null = null

  let fieldsLane: Lane<CollectionFields> | null = null
  let framesLane: Lane<FrameInput[]> | null = null
  const metaLanes = new Map<string, Lane<PhotoMeta>>()
  const overrideLanes = new Map<string, Lane<OverrideInput>>()

  let loadGen = 0
  let disposed = false
  let lastSavedFields: CollectionFields | null = null
  let lastSavedFrames: FrameInput[] | null = null

  function bumpHistoryFlags() {
    canUndo.value = history.canUndo()
    canRedo.value = history.canRedo()
  }

  function ifUpdatedAt(): number | null {
    return forceWrite.value ? null : updatedAt.value
  }

  function noteUpdated(n: number) {
    if (Number.isFinite(n) && n > 0) updatedAt.value = n
    if (collection.value) collection.value = { ...collection.value, updatedAt: updatedAt.value }
  }

  function noteWrite(w: OwnerCollectionWrite) {
    noteUpdated(w.updatedAt)
    if (collection.value) collection.value = applyWrite(collection.value, w)
  }

  function fail(message: string): SendResult {
    return { ok: false, message: message || FALLBACK }
  }

  function onConflict() {
    conflictOpen.value = true
    for (const l of collectLanes()) l.pause()
  }

  function collectLanes(): Lane<unknown>[] {
    const out: Lane<unknown>[] = []
    if (fieldsLane) out.push(fieldsLane as Lane<unknown>)
    if (framesLane) out.push(framesLane as Lane<unknown>)
    for (const l of metaLanes.values()) out.push(l as Lane<unknown>)
    for (const l of overrideLanes.values()) out.push(l as Lane<unknown>)
    return out
  }

  // Spec §6: saves in one tab run one at a time, so each write reads the
  // updatedAt left by the previous one. Lanes still coalesce independently;
  // only the network sends are chained. Every write bumps updatedAt, so all
  // four lane kinds share the chain.
  let chain: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }


  function sendResultFrom<T>(r: { ok: true; data: T } | { ok: false; message: string; conflictAt?: number }, take: (data: T) => void): SendResult {
    if (r.ok) {
      take(r.data)
      return { ok: true }
    }
    if (r.conflictAt !== undefined) return { ok: false, message: r.message || FALLBACK, conflict: true }
    return fail(r.message)
  }

  async function sendFields(v: CollectionFields): Promise<SendResult> {
    const cid = id.value
    const r = await putCollection(cid, v, ifUpdatedAt())
    return sendResultFrom(r, (data) => {
      lastSavedFields = cloneFields(v)
      noteWrite(data)
    })
  }

  async function sendFrames(v: FrameInput[]): Promise<SendResult> {
    const cid = id.value
    const r = await putFrames(cid, v, ifUpdatedAt())
    return sendResultFrom(r, (data) => {
      lastSavedFrames = v
      noteWrite(data)
    })
  }

  async function sendMeta(photoId: string, v: PhotoMeta): Promise<SendResult> {
    const r = await putPhotoMeta(photoId, v)
    if (r.ok) {
      const hit = r.data.collections.find((x) => x.id === id.value)
      if (hit) noteUpdated(hit.updatedAt)
      const d = photos[photoId]
      if (d) photos[photoId] = { ...d, title: v.title, caption: v.caption }
      return { ok: true }
    }
    return fail(r.message)
  }

  async function sendOverride(photoId: string, v: OverrideInput): Promise<SendResult> {
    const r = await putOverride(id.value, photoId, v)
    if (r.ok) {
      noteUpdated(r.data.updatedAt)
      const d = photos[photoId]
      if (d) {
        photos[photoId] = {
          ...d,
          publicFields: v.publicFields,
          histogramPublic: v.histogramPublic ?? d.histogramPublic,
        }
      }
      return { ok: true }
    }
    return fail(r.message)
  }

  function ensureLanes() {
    if (fieldsLane) return
    fieldsLane = createLane((v: CollectionFields) => serial(() => sendFields(v)), onConflict)
    framesLane = createLane((v: FrameInput[]) => serial(() => sendFrames(v)), onConflict)
  }

  function metaLane(photoId: string): Lane<PhotoMeta> {
    let l = metaLanes.get(photoId)
    if (!l) {
      l = createLane((v: PhotoMeta) => serial(() => sendMeta(photoId, v)), onConflict)
      metaLanes.set(photoId, l)
    }
    return l
  }

  function overrideLane(photoId: string): Lane<OverrideInput> {
    let l = overrideLanes.get(photoId)
    if (!l) {
      l = createLane((v: OverrideInput) => serial(() => sendOverride(photoId, v)), onConflict)
      overrideLanes.set(photoId, l)
    }
    return l
  }

  function validityMessage(s: Seq): string {
    const v = isValid(s)
    if (v.ok) return ''
    return chineseReason(v.index, v.reason)
  }

  function laneBusy(l: Lane<unknown> | null | undefined): boolean {
    if (!l) return false
    const st = l.state.value
    return st === 'saving' || st === 'pending' || st === 'error' || st === 'paused' || l.pendingValue() !== undefined
  }

  const saveState = computed<SaveState>(() => {
    if (conflictOpen.value) return 'conflict'
    const lanes = collectLanes()
    if (lanes.some((l) => l.state.value === 'error')) return 'error'
    if (lanes.some((l) => l.state.value === 'saving' || l.state.value === 'pending')) return 'saving'
    if (!isValid(seq.value).ok) return 'unsaved'
    if (lanes.some((l) => laneBusy(l))) return 'saving'
    return 'saved'
  })

  const saveError = computed(() => {
    if (!isValid(seq.value).ok) return validityMessage(seq.value)
    for (const l of collectLanes()) {
      if (l.state.value === 'error' && l.error.value) return l.error.value
    }
    return errorMessage.value
  })

  function persistBackup() {
    const cid = id.value
    if (!cid || state.value !== 'ready') return
    const busy = collectLanes().some((l) => laneBusy(l)) || !isValid(seq.value).ok || exposureOpen.value
    if (!busy) {
      clearBackup(cid)
      return
    }
    const b: Backup<CollectionFields, FrameInput[]> = {
      baseUpdatedAt: updatedAt.value,
      savedAt: Date.now(),
      fields: cloneFields(fields.value),
      frames: toInput(seq.value),
    }
    clearBackup(cid)
    saveBackup(cid, b)
  }

  watch(saveState, persistBackup)

  function scheduleFrames() {
    if (!framesLane) return
    const v = isValid(seq.value)
    if (!v.ok) {
      errorMessage.value = chineseReason(v.index, v.reason)
      persistBackup()
      return
    }
    errorMessage.value = ''
    const input = toInput(seq.value)
    if (lastSavedFrames && sameFrames(input, lastSavedFrames) && framesLane.pendingValue() === undefined && framesLane.state.value === 'idle') {
      persistBackup()
      return
    }
    framesLane.schedule(input, { debounceMs: 0 })
    persistBackup()
  }

  function scheduleFields(kind: 'field' | 'exposure') {
    if (!fieldsLane) return
    fieldsLane.schedule(cloneFields(fields.value), { debounceMs: kind === 'field' ? 800 : 0 })
    persistBackup()
  }

  async function runCheck(body: ExposureCheckInput): Promise<{ widens: boolean; changes: ExposureChange[] } | null> {
    const r = await exposureCheck(id.value, body)
    if (!r.ok) {
      errorMessage.value = r.message || FALLBACK
      return null
    }
    return r.data
  }

  function published(): boolean {
    return collection.value?.status === 'published'
  }

  async function gateFrames(next: Seq, prev: Seq) {
    if (!published() || !mayWidenFrames(prev, next)) {
      scheduleFrames()
      return
    }
    checking = true
    const r = await runCheck({ frames: toInput(next) })
    checking = false
    if (!r) {
      seq.value = prev
      history.reset(prev)
      bumpHistoryFlags()
      drainQueued()
      return
    }
    if (!r.widens) {
      scheduleFrames()
      drainQueued()
      return
    }
    pendingExposure = { kind: 'frames', next, prev }
    exposureChanges.value = r.changes
    exposureOpen.value = true
  }

  async function gateFields(next: CollectionFields, prev: CollectionFields, kind: 'field' | 'exposure') {
    if (kind === 'field' || !published() || !fieldsMayWiden(prev, next)) {
      scheduleFields(kind)
      return
    }
    checking = true
    const r = await runCheck({ collection: next })
    checking = false
    if (!r) {
      fields.value = cloneFields(prev)
      return
    }
    if (!r.widens) {
      scheduleFields(kind)
      return
    }
    pendingExposure = { kind: 'fields', next, prev }
    exposureChanges.value = r.changes
    exposureOpen.value = true
  }

  async function gateOverride(photoId: string, next: OverrideInput, prev: OverrideInput) {
    if (!published()) {
      overrideLane(photoId).schedule(next, { debounceMs: 0 })
      persistBackup()
      return
    }
    checking = true
    const r = await runCheck({ override: { ...next, photoId } })
    checking = false
    if (!r) {
      overrides[photoId] = prev
      return
    }
    if (!r.widens) {
      overrideLane(photoId).schedule(next, { debounceMs: 0 })
      persistBackup()
      return
    }
    pendingExposure = { kind: 'override', photoId, next, prev }
    exposureChanges.value = r.changes
    exposureOpen.value = true
  }

  function drainQueued() {
    if (queuedSeq === null || exposureOpen.value || checking) return
    const next = queuedSeq
    queuedSeq = null
    applySeq(next, 'structure')
  }

  function confirmExposure() {
    const p = pendingExposure
    pendingExposure = null
    exposureOpen.value = false
    exposureChanges.value = []
    if (!p) return
    if (p.kind === 'frames') scheduleFrames()
    else if (p.kind === 'fields') scheduleFields('exposure')
    else {
      overrideLane(p.photoId).schedule(p.next, { debounceMs: 0 })
      persistBackup()
    }
    drainQueued()
  }

  function cancelExposure() {
    const p = pendingExposure
    pendingExposure = null
    exposureOpen.value = false
    exposureChanges.value = []
    if (!p) return
    if (p.kind === 'frames') {
      seq.value = p.prev
      history.undo()
      bumpHistoryFlags()
    } else if (p.kind === 'fields') {
      fields.value = cloneFields(p.prev)
    } else {
      overrides[p.photoId] = p.prev
    }
    queuedSeq = null
    persistBackup()
  }

  function applySeq(next: Seq, _kind: 'structure') {
    if (state.value !== 'ready' || next === seq.value) return
    if (exposureOpen.value || checking) {
      // Send nothing while a dialog is pending; cancel drops this, confirm applies it.
      queuedSeq = next
      return
    }
    const prev = seq.value
    seq.value = next
    history.push(next)
    bumpHistoryFlags()
    void gateFrames(next, prev)
  }

  function applyFields(next: CollectionFields, kind: 'field' | 'exposure') {
    // While a check or dialog is pending, local fields may hold an unconfirmed
    // widening; any send now would leak it. The UI is disabled meanwhile.
    if (state.value !== 'ready' || exposureOpen.value || checking) return
    const prev = cloneFields(fields.value)
    fields.value = cloneFields(next)
    void gateFields(next, prev, kind)
  }

  function setPhotoMeta(photoId: string, m: PhotoMeta) {
    if (state.value !== 'ready') return
    const d = photos[photoId]
    if (d) photos[photoId] = { ...d, title: m.title, caption: m.caption }
    metaLane(photoId).schedule({ title: m.title, caption: m.caption }, { debounceMs: 800 })
    persistBackup()
  }

  function setOverride(photoId: string, o: OverrideInput) {
    if (state.value !== 'ready' || exposureOpen.value || checking) return
    const prev = overrides[photoId] ?? {
      publicFields: photos[photoId]?.publicFields ?? [],
      histogramPublic: photos[photoId]?.histogramPublic ?? false,
    }
    overrides[photoId] = o
    void gateOverride(photoId, o, prev)
  }

  function undo() {
    if (exposureOpen.value) return
    const prev = history.undo()
    if (prev == null) return
    const before = seq.value
    seq.value = prev
    bumpHistoryFlags()
    void gateFrames(prev, before)
  }

  function redo() {
    if (exposureOpen.value) return
    const next = history.redo()
    if (next == null) return
    const before = seq.value
    seq.value = next
    bumpHistoryFlags()
    void gateFrames(next, before)
  }

  async function reloadFromServer() {
    const cid = id.value
    const gen = ++loadGen
    const r = await getOwnerCollection(cid)
    if (gen !== loadGen || disposed || cid !== id.value) return
    if (!r.ok) {
      state.value = r.status === 404 ? 'missing' : 'error'
      errorMessage.value = r.status === 404 ? '' : FALLBACK
      return
    }
    adopt(r.data)
  }

  function seedPhotos(c: OwnerCollection) {
    for (const k of Object.keys(photos)) delete photos[k]
    for (const k of Object.keys(overrides)) delete overrides[k]
    const d = detailsFrom(c)
    for (const [k, v] of Object.entries(d)) photos[k] = v
    for (const f of c.frames) {
      for (const p of f.photos) {
        if (p.override) {
          overrides[p.id] = {
            publicFields: p.override.publicFields ?? p.publicFields,
            histogramPublic: p.override.histogramPublic,
          }
        }
      }
    }
  }

  function adopt(c: OwnerCollection) {
    ensureLanes()
    collection.value = c
    updatedAt.value = c.updatedAt
    fields.value = pickFields(c)
    const s = fromOwner(c)
    seq.value = s
    history.reset(s)
    bumpHistoryFlags()
    seedPhotos(c)
    lastSavedFields = cloneFields(fields.value)
    lastSavedFrames = toInput(s)
    selected.value = 0
    errorMessage.value = ''
    conflictOpen.value = false
    exposureOpen.value = false
    pendingExposure = null
    queuedSeq = null
    overwritePending = null
    forceWrite.value = false
    state.value = 'ready'
    for (const l of collectLanes()) l.resume()
    considerBackup(c)
  }

  function considerBackup(c: OwnerCollection) {
    backupOfferOpen.value = false
    storedBackup = loadBackup<CollectionFields, FrameInput[]>(c.id)
    if (!storedBackup) return
    if (storedBackup.baseUpdatedAt !== c.updatedAt) return
    const serverFields = pickFields(c)
    const serverFrames = toInput(fromOwner(c))
    if (sameFields(storedBackup.fields, serverFields) && sameFrames(storedBackup.frames, serverFrames)) return
    backupOfferOpen.value = true
  }

  function restoreBackup() {
    const b = storedBackup
    backupOfferOpen.value = false
    if (!b || state.value !== 'ready') return
    fields.value = cloneFields(b.fields)
    // The backup stores FrameInput (photo ids only). Rebuild DeskPhotos from the
    // photos the server sequence already has; an unknown id gets an empty shell.
    const byId = new Map<string, { id: string; title: string; media: OwnerFramePhoto['media']; width: number | null; height: number | null }>()
    for (const f of seq.value) for (const p of f.photos) byId.set(p.id, p)
    const rebuilt: Seq = b.frames.map((f, i) => ({
      key: `b${i}`,
      layout: f.layout,
      matteRatio: f.layout === 'matted' ? f.matteRatio : null,
      text: f.layout === 'text' ? f.text : null,
      photos: f.photoIds.map((pid) => byId.get(pid) ?? { id: pid, title: '', media: null, width: null, height: null }),
    }))
    const serverSeq = seq.value
    const serverFields = lastSavedFields ?? cloneFields(fields.value)
    seq.value = rebuilt
    history.reset(rebuilt)
    bumpHistoryFlags()
    storedBackup = null
    // Restoring is an edit like any other: published collections go through the check.
    void gateFields(fields.value, serverFields, 'exposure')
    void gateFrames(rebuilt, serverSeq)
    persistBackup()
  }

  function discardBackup() {
    backupOfferOpen.value = false
    storedBackup = null
    clearBackup(id.value)
  }

  async function reloadConflict() {
    clearBackup(id.value)
    conflictOpen.value = false
    forceWrite.value = false
    for (const l of collectLanes()) l.dispose()
    fieldsLane = null
    framesLane = null
    metaLanes.clear()
    overrideLanes.clear()
    await reloadFromServer()
  }

  /** Set while the exposure dialog guards an overwrite (fields and frames together). */
  let overwritePending: { prevFields: CollectionFields; prevSeq: Seq } | null = null

  async function overwriteConflict() {
    forceWrite.value = true
    conflictOpen.value = false
    for (const l of collectLanes()) l.resume()
    if (published()) {
      // Pause again until the check settles so nothing goes out unconfirmed.
      for (const l of collectLanes()) l.pause()
      checking = true
      const r = await runCheck({ collection: cloneFields(fields.value), frames: toInput(seq.value) })
      checking = false
      if (!r) {
        forceWrite.value = false
        conflictOpen.value = true
        return
      }
      if (r.widens) {
        overwritePending = { prevFields: cloneFields(fields.value), prevSeq: seq.value }
        exposureChanges.value = r.changes
        exposureOpen.value = true
        return
      }
      for (const l of collectLanes()) l.resume()
    }
    scheduleFields('exposure')
    scheduleFrames()
  }

  function confirmExposureWrapped() {
    const over = overwritePending
    overwritePending = null
    if (over) {
      exposureOpen.value = false
      exposureChanges.value = []
      pendingExposure = null
      for (const l of collectLanes()) l.resume()
      scheduleFields('exposure')
      scheduleFrames()
      return
    }
    confirmExposure()
  }

  function cancelExposureWrapped() {
    const over = overwritePending
    overwritePending = null
    if (over) {
      // Back to the conflict banner: the server still holds the other version.
      forceWrite.value = false
      exposureOpen.value = false
      exposureChanges.value = []
      pendingExposure = null
      conflictOpen.value = true
      persistBackup()
      return
    }
    cancelExposure()
  }

  async function publish(): Promise<Manifest | null> {
    const r = await publishDryRun(id.value)
    if (!r.ok) {
      errorMessage.value = r.message || FALLBACK
      return null
    }
    return r.data
  }

  async function confirmPublish(): Promise<boolean> {
    const r = await publishCollection(id.value)
    if (!r.ok) {
      errorMessage.value = r.message || FALLBACK
      return false
    }
    noteWrite(r.data)
    return true
  }

  async function unpublish(): Promise<boolean> {
    const r = await unpublishCollection(id.value)
    if (!r.ok) {
      errorMessage.value = r.message || FALLBACK
      return false
    }
    noteWrite(r.data)
    return true
  }

  async function remove(): Promise<boolean> {
    const r = await deleteCollection(id.value)
    if (!r.ok) {
      errorMessage.value = r.message || FALLBACK
      return false
    }
    clearBackup(id.value)
    return true
  }

  const previewCollection = computed<Collection | null>(() => {
    const c = collection.value
    if (!c || state.value !== 'ready') return null
    return toPreview({ id: c.id, owner: c.owner, publishedAt: c.publishedAt }, fields.value, seq.value, photos)
  })

  const exposure = computed<ExposureDialog | null>(() => {
    if (!exposureOpen.value) return null
    return {
      open: true,
      changes: exposureChanges.value,
      confirm: confirmExposureWrapped,
      cancel: cancelExposureWrapped,
    }
  })

  const conflict = computed<ConflictDialog | null>(() => {
    if (!conflictOpen.value) return null
    return { reload: reloadConflict, overwrite: overwriteConflict }
  })

  const backupOffer = computed<BackupOffer | null>(() => {
    if (!backupOfferOpen.value) return null
    return { restore: restoreBackup, discard: discardBackup }
  })

  function dispose() {
    disposed = true
    loadGen += 1
    for (const l of collectLanes()) l.dispose()
    fieldsLane = null
    framesLane = null
    metaLanes.clear()
    overrideLanes.clear()
  }

  watch(
    id,
    (cid) => {
      dispose()
      disposed = false
      state.value = 'loading'
      collection.value = null
      backupOfferOpen.value = false
      conflictOpen.value = false
      exposureOpen.value = false
      if (!cid) {
        state.value = 'missing'
        return
      }
      void reloadFromServer()
    },
    { immediate: true },
  )

  if (getCurrentScope()) onScopeDispose(dispose)

  return {
    state: computed(() => state.value),
    collection: computed(() => collection.value),
    fields: computed(() => fields.value),
    seq: computed(() => seq.value),
    selected,
    saveState,
    errorMessage: saveError,
    exposure,
    conflict,
    backupOffer,
    previewCollection,
    canUndo: computed(() => canUndo.value),
    canRedo: computed(() => canRedo.value),
    applySeq,
    applyFields,
    setPhotoMeta,
    setOverride,
    undo,
    redo,
    publish,
    confirmPublish,
    unpublish,
    remove,
    dispose,
  }
}
