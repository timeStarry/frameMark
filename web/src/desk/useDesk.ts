// useDesk.ts — the curation desk's reactive state (spec §4.5, §4.6, §6).
// Wires the sequence model, undo history, save lanes, local backup, the
// exposure-check confirmation for published collections, and 409 handling.
import { computed, getCurrentScope, onScopeDispose, reactive, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
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
import type { GuardedResult } from '../api/desk'
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
  PhotoMetaView,
  OverrideView,
} from '../api/types'
import { clearBackup, loadBackup, saveBackup, type Backup } from './backup'
import { toPreview, type PhotoDetail } from './preview'
import { createLane, type Lane, type SendResult } from './saveQueue'
import { fromOwner, isValid, photoIds, toInput, type DeskPhoto, type Seq } from './sequence'
import type { WriteResult } from '../api/write'

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

/** What the property panel shows for one photo in this collection. */
export interface PhotoProps {
  title: string
  caption: string
  publicFields: string[]
  histogramPublic: boolean
  /** This collection has an override row for the photo. */
  overridden: boolean
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
  /** True while an exposure check or a publish/unpublish/delete is in flight; the UI disables editing. */
  checking: ComputedRef<boolean>
  applySeq(next: Seq, kind: 'structure'): void
  applyFields(next: CollectionFields, kind: 'field' | 'exposure'): void
  setPhotoMeta(photoId: string, m: PhotoMeta): void
  setOverride(photoId: string, o: OverrideInput): void
  /** Per photo in the sequence: meta and effective exposure, local edits included. */
  photoProps: ComputedRef<Record<string, PhotoProps>>
  /** 恢复默认: drops this collection's override. Gated like setOverride, since it can widen. */
  clearOverride(photoId: string): void
  undo(): void
  redo(): void
  /** Resends failed writes and re-runs a failed exposure check. */
  retry(): void
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


const UNSAVED_MSG = '还有未保存的修改，保存后再发布'
const STALE_MANIFEST_MSG = '内容有变化，请重新确认发布清单'
const OVERWRITE_INVALID_MSG = '序列还有问题，修好后再覆盖'
const REFETCH_FAILED_MSG = '读取最新版本失败，暂时不能覆盖'
const WIDEN_KEYS = ['visibility', 'distribute', 'originalDownload'] as const

/** Lanes, chain and identity of one load. A stale session never sends or writes state. */
interface Session {
  gen: number
  cid: string
  chain: Promise<unknown>
  fields: Lane<CollectionFields>
  frames: Lane<FrameInput[]>
  meta: Map<string, Lane<PhotoMeta>>
  overrides: Map<string, Lane<OverrideInput>>
  /** One-shot overwrite: the next successful fields / frames write omits ifUpdatedAt. */
  force: { fields: boolean; frames: boolean }
  /** updatedAt the last dry-run manifest was built on. */
  manifestAt: number | null
}

/** What one exposure check covered. Cancel or a failure reverts exactly these parts. */
interface Checked {
  fields?: CollectionFields
  frames?: Seq
  override?: { photoId: string; value: OverrideInput }
  overwrite?: boolean
}

interface HistorySnap {
  past: Seq[]
  present: Seq
  future: Seq[]
}

/**
 * Undo stack with snapshots (spec §4.6). history.ts has no snapshot API, and a
 * cancelled edit must put past and future back exactly (review I3).
 */
function createSnapHistory(initial: Seq, max = 50) {
  let past: Seq[] = []
  let future: Seq[] = []
  let present = initial
  return {
    current: () => present,
    push(next: Seq) {
      past.push(present)
      if (past.length > max) past.splice(0, past.length - max)
      present = next
      future = []
    },
    undo(): Seq | null {
      const p = past.pop()
      if (p === undefined) return null
      future.push(present)
      present = p
      return p
    },
    redo(): Seq | null {
      const f = future.pop()
      if (f === undefined) return null
      past.push(present)
      present = f
      return f
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    reset(v: Seq) {
      past = []
      future = []
      present = v
    },
    snapshot: (): HistorySnap => ({ past: past.slice(), present, future: future.slice() }),
    restore(s: HistorySnap) {
      past = s.past.slice()
      present = s.present
      future = s.future.slice()
    },
  }
}

/** An override value meaning "drop the row" (publicFields and histogramPublic both null). */
const isClear = (o: OverrideInput | undefined) => !!o && o.publicFields === null && o.histogramPublic === null

const sameOverride = (a: OverrideInput | undefined, b: OverrideInput | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

type Guarded<T> = GuardedResult<T> | WriteResult<T>

export function useDesk(id: Ref<string>): Desk {
  const state = ref<DeskState>('loading')
  const collection = shallowRef<OwnerCollection | null>(null)
  const fields = shallowRef<CollectionFields>({
    title: '',
    intro: '',
    visibility: 'private',
    distribute: false,
    originalDownload: false,
    license: null,
    aiDeclaration: null,
    coverPhotoId: null,
  })
  const seq = shallowRef<Seq>([])
  const selected = ref(0)
  const errorMessage = ref('')
  const checkError = ref('')
  const updatedAt = ref(0)
  const photos = reactive<Record<string, PhotoDetail>>({})
  /** Local (desired) overrides; confirmedOverrides is what was cleared to send. */
  const overrides = reactive<Record<string, OverrideInput>>({})
  const confirmedOverrides = reactive<Record<string, OverrideInput>>({})
  /** The fields / sequence last cleared to send (non-widening, checked or confirmed). */
  const confirmedFields = shallowRef<CollectionFields>(fields.value)
  const confirmedSeq = shallowRef<Seq>([])
  const canUndo = ref(false)
  const canRedo = ref(false)
  const history = createSnapHistory([])
  /** History before the sequence left confirmedSeq; null while they match. */
  let base: HistorySnap | null = null

  const conflictOpen = ref(false)
  const backupOfferOpen = ref(false)
  let storedBackup: Backup<CollectionFields, FrameInput[]> | null = null

  const exposureOpen = ref(false)
  const exposureChanges = ref<ExposureChange[]>([])
  let pending: Checked | null = null
  const checkInFlight = ref(false)
  let checkToken = 0
  const opBusy = ref(0)
  /** The latest structural edit made while a check, dialog or publish was pending. */
  let queuedSeq: Seq | null = null
  let fieldsDebounce = 0

  let session: Session | null = null
  const lanesVersion = ref(0)
  let loadGen = 0
  let disposed = false

  const live = (s: Session | null): s is Session => s !== null && s === session && !disposed && s.gen === loadGen

  function bumpHistoryFlags() {
    canUndo.value = history.canUndo()
    canRedo.value = history.canRedo()
  }

  function noteUpdated(n: number) {
    if (Number.isFinite(n) && n > 0) updatedAt.value = n
    if (collection.value) collection.value = { ...collection.value, updatedAt: updatedAt.value }
  }

  function noteWrite(w: OwnerCollectionWrite) {
    noteUpdated(w.updatedAt)
    if (collection.value) collection.value = applyWrite(collection.value, w)
  }

  // Spec §6: one tab's writes run one at a time, so each reads the updatedAt
  // the previous one left. Per session, so an id change starts a fresh chain.
  function serial<T>(s: Session, fn: () => Promise<T>): Promise<T> {
    const run = s.chain.then(fn, fn)
    s.chain = run.catch(() => undefined)
    return run
  }

  /** A stale send is dropped: reporting success empties the dead lane quietly. */
  const DROPPED: SendResult = { ok: true }

  function result<T>(r: Guarded<T>, take: (data: T) => void): SendResult {
    if (r.ok) {
      take(r.data)
      return { ok: true }
    }
    if ((r as GuardedResult<T>).conflictAt !== undefined) return { ok: false, message: r.message || FALLBACK, conflict: true }
    return { ok: false, message: r.message || FALLBACK }
  }

  function guardedSend<T>(s: Session, call: () => Promise<Guarded<T>>, take: (data: T) => void): Promise<SendResult> {
    return serial(s, async () => {
      if (!live(s)) return DROPPED
      let r: Guarded<T>
      try {
        r = await call()
      } catch {
        r = { ok: false, status: 0, message: FALLBACK }
      }
      if (!live(s)) return DROPPED
      return result(r, take)
    })
  }

  function onConflict(s: Session) {
    if (!live(s)) return
    conflictOpen.value = true
    for (const l of lanesOf(s)) l.pause()
  }

  function createSession(cid: string): Session {
    const s = {
      gen: loadGen,
      cid,
      chain: Promise.resolve(),
      meta: new Map(),
      overrides: new Map(),
      force: { fields: false, frames: false },
      manifestAt: null,
    } as unknown as Session
    s.fields = createLane(
      (v: CollectionFields) =>
        guardedSend(
          s,
          () => putCollection(s.cid, v, s.force.fields ? null : updatedAt.value),
          (data) => {
            s.force.fields = false
            noteWrite(data)
          },
        ),
      () => onConflict(s),
    )
    s.frames = createLane(
      (v: FrameInput[]) =>
        guardedSend(
          s,
          () => putFrames(s.cid, v, s.force.frames ? null : updatedAt.value),
          (data) => {
            s.force.frames = false
            noteWrite(data)
          },
        ),
      () => onConflict(s),
    )
    return s
  }

  function metaLane(s: Session, photoId: string): Lane<PhotoMeta> {
    let l = s.meta.get(photoId)
    if (!l) {
      l = createLane(
        (v: PhotoMeta) =>
          guardedSend<PhotoMetaView>(
            s,
            () => putPhotoMeta(photoId, v),
            (data) => {
              const hit = data.collections.find((x) => x.id === s.cid)
              if (hit) noteUpdated(hit.updatedAt)
            },
          ),
        () => onConflict(s),
      )
      s.meta.set(photoId, l)
      lanesVersion.value += 1
    }
    return l
  }

  function overrideLane(s: Session, photoId: string): Lane<OverrideInput> {
    let l = s.overrides.get(photoId)
    if (!l) {
      l = createLane(
        (v: OverrideInput) =>
          guardedSend<OverrideView>(
            s,
            () => putOverride(s.cid, photoId, v),
            (data) => {
              noteUpdated(data.updatedAt)
              if (isClear(v)) void refreshDefaults(s, photoId)
            },
          ),
        () => onConflict(s),
      )
      s.overrides.set(photoId, l)
      lanesVersion.value += 1
    }
    return l
  }

  /**
   * After a cleared override the photo shows its snapshot defaults. The
   * override response carries no defaults, so read them from the owner
   * collection. Only this photo's exposure is taken; updatedAt and every
   * other local edit stay as they are.
   */
  async function refreshDefaults(s: Session, photoId: string) {
    let r: Awaited<ReturnType<typeof getOwnerCollection>>
    try {
      r = await getOwnerCollection(s.cid)
    } catch {
      return
    }
    if (!live(s) || !r.ok) return
    // A newer override was set meanwhile: it wins.
    if (!isClear(overrides[photoId]) || !isClear(confirmedOverrides[photoId])) return
    const p = r.data.frames.flatMap((f) => f.photos).find((x) => x.id === photoId)
    const d = photos[photoId]
    if (p && d) photos[photoId] = { ...d, publicFields: p.publicFields, histogramPublic: p.histogramPublic }
    delete overrides[photoId]
    delete confirmedOverrides[photoId]
  }

  function lanesOf(s: Session | null): Lane<unknown>[] {
    if (!s) return []
    const out: Lane<unknown>[] = [s.fields as Lane<unknown>, s.frames as Lane<unknown>]
    for (const l of s.meta.values()) out.push(l as Lane<unknown>)
    for (const l of s.overrides.values()) out.push(l as Lane<unknown>)
    return out
  }

  function currentLanes(): Lane<unknown>[] {
    void lanesVersion.value
    return lanesOf(session)
  }

  function laneBusy(l: Lane<unknown>): boolean {
    const st = l.state.value
    return st !== 'idle' || l.pendingValue() !== undefined
  }

  function unconfirmed(): boolean {
    if (!sameFields(fields.value, confirmedFields.value)) return true
    if (!sameFrames(toInput(seq.value), toInput(confirmedSeq.value))) return true
    const ids = new Set([...Object.keys(overrides), ...Object.keys(confirmedOverrides)])
    for (const pid of ids) if (!sameOverride(overrides[pid], confirmedOverrides[pid])) return true
    return false
  }

  const saveState = computed<SaveState>(() => {
    if (conflictOpen.value) return 'conflict'
    const lanes = currentLanes()
    if (checkError.value || lanes.some((l) => l.state.value === 'error')) return 'error'
    if (checkInFlight.value || lanes.some((l) => l.state.value === 'saving' || l.state.value === 'pending')) return 'saving'
    if (!isValid(seq.value).ok || exposureOpen.value || unconfirmed() || lanes.some(laneBusy)) return 'unsaved'
    return 'saved'
  })

  const saveError = computed(() => {
    const v = isValid(seq.value)
    if (!v.ok) return chineseReason(v.index, v.reason)
    for (const l of currentLanes()) if (l.state.value === 'error' && l.error.value) return l.error.value
    return checkError.value || errorMessage.value
  })

  function persistBackup() {
    const s = session
    if (!live(s) || state.value !== 'ready') return
    clearBackup(s.cid)
    if (saveState.value === 'saved') return
    saveBackup<CollectionFields, FrameInput[]>(s.cid, {
      baseUpdatedAt: updatedAt.value,
      savedAt: Date.now(),
      fields: cloneFields(fields.value),
      frames: toInput(seq.value),
    })
  }

  watch(saveState, (v) => {
    // A publish refusal is about unsaved work; it is moot once all is saved.
    if (v === 'saved' && (errorMessage.value === UNSAVED_MSG || errorMessage.value === STALE_MANIFEST_MSG)) errorMessage.value = ''
    persistBackup()
  })

  const published = () => collection.value?.status === 'published'
  /** Structural edits, undo and redo wait while any of these is pending. */
  const structBusy = () => checkInFlight.value || exposureOpen.value || opBusy.value > 0

  function confirmFields(s: Session, f: CollectionFields, debounceMs: number) {
    confirmedFields.value = cloneFields(f)
    s.fields.schedule(cloneFields(f), { debounceMs })
  }

  function confirmFrames(s: Session, q: Seq) {
    confirmedSeq.value = q
    base = null
    s.frames.schedule(toInput(q), { debounceMs: 0 })
  }

  function confirmOverride(s: Session, photoId: string, v: OverrideInput) {
    confirmedOverrides[photoId] = { ...v }
    overrideLane(s, photoId).schedule({ ...v }, { debounceMs: 0 })
  }

  /** Puts back exactly the parts a cancelled or failed check covered. */
  function revert(c: Checked) {
    if (c.fields) {
      const f = { ...fields.value }
      for (const k of WIDEN_KEYS) (f as Record<string, unknown>)[k] = confirmedFields.value[k]
      fields.value = f
    }
    if (c.frames) {
      seq.value = confirmedSeq.value
      if (base) history.restore(base)
      base = null
      queuedSeq = null // derived from the reverted sequence
      bumpHistoryFlags()
    }
    if (c.override) {
      const pid = c.override.photoId
      const prev = confirmedOverrides[pid]
      if (prev) overrides[pid] = { ...prev }
      else delete overrides[pid]
    }
  }

  function stillEqual(c: Checked): boolean {
    if (c.fields && !sameFields(fields.value, c.fields)) return false
    if (c.frames && !sameFrames(toInput(seq.value), toInput(c.frames))) return false
    if (c.override && !sameOverride(overrides[c.override.photoId], c.override.value)) return false
    return true
  }

  function commitSeq(next: Seq) {
    if (base === null) base = history.snapshot()
    history.push(next)
    seq.value = next
    bumpHistoryFlags()
  }

  /**
   * Sends what is safe to send and checks what may widen. Nothing goes to a
   * lane while a check, dialog, publish or conflict is pending; a later
   * reconcile picks the difference up.
   */
  function reconcile() {
    const s = session
    if (!live(s) || state.value !== 'ready') return
    if (conflictOpen.value || exposureOpen.value || checkInFlight.value || opBusy.value > 0) {
      persistBackup()
      return
    }
    if (queuedSeq !== null) {
      const q = queuedSeq
      queuedSeq = null
      if (q !== seq.value) commitSeq(q)
    }
    const pub = published()
    let passed = false
    const body: ExposureCheckInput = {}
    const checked: Checked = {}

    const f = fields.value
    if (!sameFields(f, confirmedFields.value)) {
      if (!pub || !fieldsMayWiden(confirmedFields.value, f)) {
        confirmFields(s, f, fieldsDebounce)
        passed = true
      } else {
        // Send the text part now; only the widening keys wait for the check.
        const safe = { ...f }
        for (const k of WIDEN_KEYS) (safe as Record<string, unknown>)[k] = confirmedFields.value[k]
        if (!sameFields(safe, confirmedFields.value)) confirmFields(s, safe, fieldsDebounce)
        body.collection = cloneFields(f)
        checked.fields = cloneFields(f)
      }
    }

    const q = seq.value
    if (isValid(q).ok && !sameFrames(toInput(q), toInput(confirmedSeq.value))) {
      if (!pub || !mayWidenFrames(confirmedSeq.value, q)) {
        confirmFrames(s, q)
        passed = true
      } else {
        body.frames = toInput(q)
        checked.frames = q
      }
    }

    const ids = new Set([...Object.keys(overrides), ...Object.keys(confirmedOverrides)])
    for (const pid of ids) {
      const v = overrides[pid]
      if (!v || sameOverride(v, confirmedOverrides[pid])) continue
      if (!pub) {
        confirmOverride(s, pid, v)
        passed = true
      } else if (!checked.override) {
        body.override = { ...v, photoId: pid }
        checked.override = { photoId: pid, value: { ...v } }
      }
    }

    if (checked.fields || checked.frames || checked.override) void runGate(s, body, checked)
    // A passed gate (an edit sent without a check) clears an earlier check error;
    // a reconcile that found nothing to do leaves it showing.
    else if (passed) checkError.value = ''
    persistBackup()
  }

  async function runCheck(s: Session, body: ExposureCheckInput): Promise<{ token: number; r: Guarded<{ widens: boolean; changes: ExposureChange[] }> } | null> {
    const token = ++checkToken
    checkInFlight.value = true
    let r: Guarded<{ widens: boolean; changes: ExposureChange[] }>
    try {
      r = await exposureCheck(s.cid, body)
    } catch {
      r = { ok: false, status: 0, message: FALLBACK }
    }
    if (!live(s) || token !== checkToken) return null
    checkInFlight.value = false
    return { token, r }
  }

  async function runGate(s: Session, body: ExposureCheckInput, checked: Checked) {
    const res = await runCheck(s, body)
    if (!res) return
    const { r } = res
    if (!r.ok) {
      checkError.value = r.message || FALLBACK
      revert(checked)
      reconcile()
      return
    }
    // The state moved on while the check ran: never send on its behalf; re-gate.
    if (!stillEqual(checked)) {
      reconcile()
      return
    }
    checkError.value = ''
    if (!r.data.widens) {
      applyChecked(s, checked)
      reconcile()
      return
    }
    pending = checked
    exposureChanges.value = r.data.changes
    exposureOpen.value = true
    persistBackup()
  }

  function applyChecked(s: Session, c: Checked) {
    if (c.fields) confirmFields(s, c.fields, 0)
    if (c.frames) confirmFrames(s, c.frames)
    if (c.override) confirmOverride(s, c.override.photoId, c.override.value)
  }

  function closeDialog(): Checked | null {
    const p = pending
    pending = null
    exposureOpen.value = false
    exposureChanges.value = []
    return p
  }

  function confirmExposure() {
    const s = session
    const p = closeDialog()
    if (!p || !live(s)) return
    if (p.overwrite) {
      startOverwrite(s, p.fields ?? fields.value, p.frames ?? seq.value)
      return
    }
    applyChecked(s, p)
    reconcile()
  }

  function cancelExposure() {
    const p = closeDialog()
    if (!p) return
    if (p.overwrite) {
      // Back to the banner: the server still holds the other version.
      conflictOpen.value = true
      persistBackup()
      return
    }
    revert(p)
    reconcile()
  }

  function applySeq(next: Seq, _kind: 'structure') {
    if (state.value !== 'ready' || next === seq.value) return
    if (structBusy()) {
      // Send nothing while a check or dialog is pending. Cancel of a frames
      // dialog drops this; every other outcome applies it.
      queuedSeq = next
      return
    }
    commitSeq(next)
    reconcile()
  }

  function applyFields(next: CollectionFields, kind: 'field' | 'exposure') {
    // While the dialog is open the UI is disabled; local fields may hold the
    // widening under confirmation.
    if (state.value !== 'ready' || exposureOpen.value || opBusy.value > 0) return
    fieldsDebounce = kind === 'field' ? 800 : 0
    fields.value = cloneFields(next)
    reconcile()
  }

  function setPhotoMeta(photoId: string, m: PhotoMeta) {
    const s = session
    if (!live(s) || state.value !== 'ready') return
    const d = photos[photoId]
    if (d) photos[photoId] = { ...d, title: m.title, caption: m.caption }
    metaLane(s, photoId).schedule({ title: m.title, caption: m.caption }, { debounceMs: 800 })
    persistBackup()
  }

  function setOverride(photoId: string, o: OverrideInput) {
    if (state.value !== 'ready' || exposureOpen.value || opBusy.value > 0) return
    overrides[photoId] = { publicFields: o.publicFields ? [...o.publicFields] : null, histogramPublic: o.histogramPublic }
    reconcile()
  }

  /**
   * The clear rides the override path: reconcile sends it on a draft, and on
   * a published collection exposure-checks {photoId, publicFields: null,
   * histogramPublic: null} first. Cancel reverts to the confirmed override.
   */
  function clearOverride(photoId: string) {
    if (state.value !== 'ready' || exposureOpen.value || opBusy.value > 0) return
    const cur = overrides[photoId]
    if (!cur || isClear(cur)) return
    overrides[photoId] = { publicFields: null, histogramPublic: null }
    reconcile()
  }

  function step(dir: 'undo' | 'redo') {
    if (state.value !== 'ready' || structBusy()) return
    if (dir === 'undo' ? !history.canUndo() : !history.canRedo()) return
    if (base === null) base = history.snapshot()
    const v = dir === 'undo' ? history.undo() : history.redo()
    if (v === null) return
    seq.value = v
    bumpHistoryFlags()
    reconcile()
  }

  /** 「重试」: resend failed writes and re-run a failed check. */
  function retry() {
    const s = session
    if (!live(s) || state.value !== 'ready') return
    checkError.value = ''
    for (const l of lanesOf(s)) l.retry()
    reconcile()
  }

  function seedPhotos(c: OwnerCollection) {
    for (const k of Object.keys(photos)) delete photos[k]
    for (const k of Object.keys(overrides)) delete overrides[k]
    for (const k of Object.keys(confirmedOverrides)) delete confirmedOverrides[k]
    for (const [k, v] of Object.entries(detailsFrom(c))) photos[k] = v
    for (const f of c.frames) {
      for (const p of f.photos) {
        if (p.override) {
          const o = { publicFields: p.override.publicFields ?? p.publicFields, histogramPublic: p.override.histogramPublic }
          overrides[p.id] = o
          confirmedOverrides[p.id] = { ...o }
        }
      }
    }
  }

  function endSession() {
    const s = session
    session = null
    loadGen += 1
    checkToken += 1
    for (const l of lanesOf(s)) l.dispose()
    lanesVersion.value += 1
    checkInFlight.value = false
    opBusy.value = 0
    pending = null
    exposureOpen.value = false
    exposureChanges.value = []
    queuedSeq = null
    base = null
  }

  async function reloadFromServer() {
    endSession()
    const gen = loadGen
    const cid = id.value
    const r = await getOwnerCollection(cid)
    if (gen !== loadGen || disposed || cid !== id.value) return
    if (!r.ok) {
      state.value = r.status === 404 ? 'missing' : 'error'
      errorMessage.value = r.status === 404 ? '' : FALLBACK
      return
    }
    adopt(r.data)
  }

  function adopt(c: OwnerCollection) {
    session = createSession(c.id)
    lanesVersion.value += 1
    collection.value = c
    updatedAt.value = c.updatedAt
    fields.value = pickFields(c)
    confirmedFields.value = cloneFields(fields.value)
    const s = fromOwner(c)
    seq.value = s
    confirmedSeq.value = s
    history.reset(s)
    base = null
    bumpHistoryFlags()
    seedPhotos(c)
    selected.value = 0
    errorMessage.value = ''
    checkError.value = ''
    conflictOpen.value = false
    fieldsDebounce = 0
    state.value = 'ready'
    considerBackup(c)
  }

  function considerBackup(c: OwnerCollection) {
    backupOfferOpen.value = false
    storedBackup = loadBackup<CollectionFields, FrameInput[]>(c.id)
    if (!storedBackup || storedBackup.baseUpdatedAt !== c.updatedAt) return
    if (sameFields(storedBackup.fields, pickFields(c)) && sameFrames(storedBackup.frames, toInput(fromOwner(c)))) return
    backupOfferOpen.value = true
  }

  function restoreBackup() {
    const b = storedBackup
    if (!b || state.value !== 'ready') return
    // Busy: keep the offer open and the backup in hand; the owner can retry
    // once the check or dialog settles. Never drop it (review m3).
    if (structBusy() || conflictOpen.value) return
    backupOfferOpen.value = false
    storedBackup = null
    // The backup holds photo ids only; rebuild DeskPhotos from the loaded ones.
    const byId = new Map<string, DeskPhoto>()
    for (const f of seq.value) for (const p of f.photos) byId.set(p.id, p)
    const rebuilt: Seq = b.frames.map((f, i) => ({
      key: `b${i}`,
      layout: f.layout,
      matteRatio: f.layout === 'matted' ? f.matteRatio : null,
      text: f.layout === 'text' ? f.text : null,
      photos: f.photoIds.map((pid) => byId.get(pid) ?? { id: pid, title: '', media: null, width: null, height: null }),
    }))
    fieldsDebounce = 0
    fields.value = cloneFields(b.fields)
    // One edit: a single reconcile, so a published collection gets one
    // combined {collection, frames} check and one dialog (review C4).
    commitSeq(rebuilt)
    reconcile()
  }

  function discardBackup() {
    backupOfferOpen.value = false
    storedBackup = null
    clearBackup(id.value)
  }

  async function reloadConflict() {
    clearBackup(id.value)
    conflictOpen.value = false
    await reloadFromServer()
  }

  /**
   * Takes the server's current version as the baseline (status, visibility,
   * fields, frames, updatedAt) while keeping the owner's local edits.
   */
  function adoptServerCopy(c: OwnerCollection) {
    collection.value = c
    updatedAt.value = c.updatedAt
    confirmedFields.value = pickFields(c)
    confirmedSeq.value = fromOwner(c)
    for (const [k, v] of Object.entries(detailsFrom(c))) if (!photos[k]) photos[k] = v
  }

  /** Schedules the overwrite values into the paused lanes first, then resumes (review I7). */
  function startOverwrite(s: Session, f: CollectionFields, q: Seq) {
    s.force = { fields: true, frames: true }
    conflictOpen.value = false
    confirmFields(s, f, 0)
    confirmFrames(s, q)
    for (const l of lanesOf(s)) l.resume()
    reconcile()
  }

  async function overwriteConflict() {
    const s = session
    if (!live(s) || !conflictOpen.value || checkInFlight.value) return
    if (!isValid(seq.value).ok) {
      errorMessage.value = OVERWRITE_INVALID_MSG
      return
    }
    errorMessage.value = ''
    const f = cloneFields(fields.value)
    const q = seq.value
    // A conflict means our copy of the server is stale, its status included
    // (another tab may have published). Refetch, then always run the combined
    // check against the server's state; the server answers widens:false for a
    // draft (review N1). Lanes stay paused throughout.
    const token = ++checkToken
    checkInFlight.value = true
    let fresh: Awaited<ReturnType<typeof getOwnerCollection>>
    try {
      fresh = await getOwnerCollection(s.cid)
    } catch {
      fresh = { ok: false, status: 0 }
    }
    if (!live(s) || token !== checkToken) return
    checkInFlight.value = false
    if (!fresh.ok) {
      errorMessage.value = REFETCH_FAILED_MSG
      return
    }
    adoptServerCopy(fresh.data)
    conflictOpen.value = false
    const res = await runCheck(s, { collection: f, frames: toInput(q) })
    if (!res) return
    const { r } = res
    if (!r.ok) {
      checkError.value = r.message || FALLBACK
      conflictOpen.value = true
      return
    }
    checkError.value = ''
    if (!sameFields(fields.value, f) || seq.value !== q) {
      conflictOpen.value = true
      return overwriteConflict()
    }
    if (r.data.widens) {
      pending = { fields: f, frames: q, overwrite: true }
      exposureChanges.value = r.data.changes
      exposureOpen.value = true
      return
    }
    startOverwrite(s, f, q)
  }

  /**
   * Publishing needs a clean desk: every lane flushed and idle, nothing
   * unconfirmed or invalid. Otherwise a draft edit could land after the
   * publish without a check (review C2).
   */
  async function settle(s: Session): Promise<boolean> {
    // A failed or paused write is not retried behind the owner's back: flush()
    // would resend it, so refuse first and let retry() handle it explicitly.
    const failed = conflictOpen.value || checkError.value !== '' || lanesOf(s).some((l) => l.state.value === 'error' || l.state.value === 'paused')
    if (failed) {
      errorMessage.value = UNSAVED_MSG
      return false
    }
    await Promise.all(lanesOf(s).map((l) => l.flush()))
    if (!live(s)) return false
    const dirty =
      conflictOpen.value ||
      checkInFlight.value ||
      exposureOpen.value ||
      checkError.value !== '' ||
      queuedSeq !== null ||
      !isValid(seq.value).ok ||
      unconfirmed() ||
      lanesOf(s).some(laneBusy)
    if (dirty) errorMessage.value = UNSAVED_MSG
    return !dirty
  }

  async function op<T>(fn: (s: Session) => Promise<T>, fallback: T): Promise<T> {
    const s = session
    if (!live(s) || state.value !== 'ready' || opBusy.value > 0 || checkInFlight.value || exposureOpen.value) return fallback
    opBusy.value += 1
    try {
      return await fn(s)
    } finally {
      if (live(s)) {
        opBusy.value -= 1
        reconcile()
      }
    }
  }

  function publish(): Promise<Manifest | null> {
    return op(async (s) => {
      errorMessage.value = ''
      if (!(await settle(s))) return null
      const r = await serial(s, () => publishDryRun(s.cid))
      if (!live(s)) return null
      if (!r.ok) {
        errorMessage.value = r.message || FALLBACK
        return null
      }
      errorMessage.value = ''
      s.manifestAt = updatedAt.value
      return r.data
    }, null)
  }

  function confirmPublish(): Promise<boolean> {
    return op(async (s) => {
      errorMessage.value = ''
      if (!(await settle(s))) return false
      const r = await serial(s, async () => {
        // Checked on the chain, after every earlier write has landed.
        if (!live(s)) return null
        if (s.manifestAt === null || s.manifestAt !== updatedAt.value) return 'stale' as const
        return publishCollection(s.cid)
      })
      if (!live(s) || r === null) return false
      if (r === 'stale') {
        s.manifestAt = null
        errorMessage.value = STALE_MANIFEST_MSG
        return false
      }
      if (!r.ok) {
        errorMessage.value = r.message || FALLBACK
        return false
      }
      s.manifestAt = null
      errorMessage.value = ''
      noteWrite(r.data)
      return true
    }, false)
  }

  function unpublish(): Promise<boolean> {
    return op(async (s) => {
      const r = await serial(s, () => unpublishCollection(s.cid))
      if (!live(s)) return false
      if (!r.ok) {
        errorMessage.value = r.message || FALLBACK
        return false
      }
      errorMessage.value = ''
      noteWrite(r.data)
      return true
    }, false)
  }

  function remove(): Promise<boolean> {
    return op(async (s) => {
      const r = await serial(s, () => deleteCollection(s.cid))
      if (!live(s)) return false
      if (!r.ok) {
        errorMessage.value = r.message || FALLBACK
        return false
      }
      clearBackup(s.cid)
      endSession()
      return true
    }, false)
  }

  const previewCollection = computed<Collection | null>(() => {
    const c = collection.value
    if (!c || state.value !== 'ready') return null
    const view: Record<string, PhotoDetail> = {}
    for (const [pid, d] of Object.entries(photos)) {
      const o = overrides[pid]
      view[pid] = o && !isClear(o) ? { ...d, publicFields: o.publicFields ?? d.publicFields, histogramPublic: o.histogramPublic ?? d.histogramPublic } : d
    }
    return toPreview({ id: c.id, owner: c.owner, publishedAt: c.publishedAt }, fields.value, seq.value, view)
  })

  const photoProps = computed<Record<string, PhotoProps>>(() => {
    const out: Record<string, PhotoProps> = {}
    for (const f of seq.value) {
      for (const p of f.photos) {
        const d = photos[p.id]
        const o = overrides[p.id]
        const live = o && !isClear(o) ? o : undefined
        out[p.id] = {
          title: d?.title ?? p.title,
          caption: d?.caption ?? '',
          publicFields: [...(live?.publicFields ?? d?.publicFields ?? [])],
          histogramPublic: live?.histogramPublic ?? d?.histogramPublic ?? false,
          overridden: live !== undefined,
        }
      }
    }
    return out
  })

  const exposure = computed<ExposureDialog | null>(() =>
    exposureOpen.value ? { open: true, changes: exposureChanges.value, confirm: confirmExposure, cancel: cancelExposure } : null,
  )

  const conflict = computed<ConflictDialog | null>(() =>
    conflictOpen.value ? { reload: reloadConflict, overwrite: overwriteConflict } : null,
  )

  const backupOffer = computed<BackupOffer | null>(() =>
    backupOfferOpen.value ? { restore: restoreBackup, discard: discardBackup } : null,
  )

  function dispose() {
    disposed = true
    endSession()
  }

  watch(
    id,
    (cid) => {
      endSession()
      state.value = 'loading'
      collection.value = null
      backupOfferOpen.value = false
      conflictOpen.value = false
      checkError.value = ''
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
    checking: computed(() => checkInFlight.value || opBusy.value > 0),
    applySeq,
    applyFields,
    setPhotoMeta,
    setOverride,
    photoProps,
    clearOverride,
    undo: () => step('undo'),
    redo: () => step('redo'),
    retry,
    publish,
    confirmPublish,
    unpublish,
    remove,
    dispose,
  }
}
