// uploadQueue.ts — the upload pipeline (spec §6): reject → hash → create →
// direct PUT to the presigned URL → complete → poll until ready/failed.
// At most `concurrency` files run the whole pipeline at once. All I/O comes
// through `deps` so tests drive it with fakes and fake timers.
import { markRaw, reactive } from 'vue'
import type { completeUpload, createUpload, getPhoto } from '../api/me'
import type { OwnerPhoto, UploadInit } from '../api/types'

export const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'] as const
export const MAX_BYTES = 60 * 1024 * 1024

export type ItemState = 'queued' | 'hashing' | 'uploading' | 'processing' | 'done' | 'duplicate' | 'failed' | 'rejected'

export interface QueueItem {
  key: string
  file: File
  state: ItemState
  progress: number
  message: string
  photo: OwnerPhoto | null
  /** failed only: true for request errors (retry starts over), false for a processing failure. */
  retryable: boolean
  /** processing only: the poll timed out; the file no longer holds a slot. */
  settled: boolean
}

export interface UploadDeps {
  hash(file: File): Promise<string>
  create: typeof createUpload
  complete: typeof completeUpload
  get: typeof getPhoto
  /** Resolves the HTTP status; 0 on network error or abort. */
  put(
    url: string,
    method: string,
    headers: Record<string, string>,
    file: File,
    onProgress: (p: number) => void,
    signal: AbortSignal,
  ): Promise<number>
  sleep(ms: number, signal: AbortSignal): Promise<void>
  now(): number
}

export interface UploadQueue {
  readonly items: Readonly<QueueItem[]>
  add(files: Iterable<File>): void
  retry(key: string): void
  clearFinished(): void
  dispose(): void
  onDone(cb: (p: OwnerPhoto) => void): void
}

export const MSG_TYPE = '不支持此格式（仅 JPEG、PNG、WebP）'
export const MSG_SIZE = '文件超过 60 MB'
export const MSG_DUPLICATE = '已在归档中'
export const MSG_PUT = '上传失败，请重试'
export const MSG_PROCESS = '处理失败'
export const MSG_TIMEOUT = '仍在处理，稍后刷新归档查看'

/** True once the item no longer needs the page (no beforeunload, can be cleared). */
export function isFinished(i: QueueItem): boolean {
  return i.state === 'done' || i.state === 'duplicate' || i.state === 'failed' || i.state === 'rejected' || i.settled
}

/** setTimeout that resolves early (and clears its timer) when the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

/** Direct PUT to S3: exactly the presigned headers, no credentials. */
export function xhrPut(
  url: string,
  method: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (p: number) => void,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(0)
    const xhr = new XMLHttpRequest()
    const onAbort = () => xhr.abort()
    const finish = (status: number) => {
      signal.removeEventListener('abort', onAbort)
      resolve(status)
    }
    xhr.open(method, url)
    xhr.withCredentials = false
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => finish(xhr.status)
    xhr.onerror = () => finish(0)
    xhr.onabort = () => finish(0)
    signal.addEventListener('abort', onAbort)
    xhr.send(file)
  })
}

const isInit = (d: UploadInit | OwnerPhoto): d is UploadInit => 'upload' in d && 'photoId' in d

export function createQueue(deps: UploadDeps, opts: { concurrency?: number; pollMs?: number; pollMaxMs?: number } = {}): UploadQueue {
  const concurrency = opts.concurrency ?? 2
  const pollMs = opts.pollMs ?? 2000
  const pollMaxMs = opts.pollMaxMs ?? 120000
  const items = reactive<QueueItem[]>([])
  const listeners: ((p: OwnerPhoto) => void)[] = []
  const life = new AbortController()
  // Each run of an item gets a token; a stale run (after dispose) stops writing.
  const runs = new Map<string, number>()
  let running = 0
  let seq = 0
  let unloadOn = false

  function onBeforeUnload(e: BeforeUnloadEvent) {
    e.preventDefault()
    e.returnValue = ''
  }

  function syncUnload() {
    const want = !life.signal.aborted && items.some((i) => !isFinished(i))
    if (want === unloadOn) return
    unloadOn = want
    if (want) window.addEventListener('beforeunload', onBeforeUnload)
    else window.removeEventListener('beforeunload', onBeforeUnload)
  }

  function set(item: QueueItem, patch: Partial<QueueItem>) {
    Object.assign(item, patch)
    syncUnload()
  }

  function pump() {
    while (running < concurrency && !life.signal.aborted) {
      const next = items.find((i) => i.state === 'queued')
      if (!next) return
      running++
      const token = (runs.get(next.key) ?? 0) + 1
      runs.set(next.key, token)
      void run(next, token).finally(() => {
        running--
        pump()
      })
    }
  }

  async function run(item: QueueItem, token: number) {
    const signal = life.signal
    const live = () => !signal.aborted && runs.get(item.key) === token
    const fail = (message: string, retryable = true) => set(item, { state: 'failed', message, retryable, progress: 0 })

    set(item, { state: 'hashing', progress: 0, message: '', retryable: false, settled: false })
    let sha256: string
    try {
      sha256 = await deps.hash(item.file)
    } catch {
      if (live()) fail(MSG_PUT)
      return
    }
    if (!live()) return

    const file = item.file
    const created = await deps.create({ filename: file.name, bytes: file.size, sha256, contentType: file.type })
    if (!live()) return
    if (!created.ok) return fail(created.message)
    if (created.status === 200 || !isInit(created.data)) {
      set(item, { state: 'duplicate', message: MSG_DUPLICATE, photo: isInit(created.data) ? null : created.data, progress: 1 })
      return
    }
    const init = created.data

    set(item, { state: 'uploading' })
    const status = await deps.put(
      init.upload.url,
      init.upload.method,
      init.upload.headers,
      file,
      (p) => {
        if (live()) item.progress = p
      },
      signal,
    )
    if (!live()) return
    if (status < 200 || status >= 300) return fail(MSG_PUT)

    const completed = await deps.complete(init.photoId)
    if (!live()) return
    if (!completed.ok) return fail(completed.message)
    let photo = completed.data
    set(item, { state: 'processing', progress: 1, photo })

    const start = deps.now()
    for (;;) {
      if (photo.status === 'ready') break
      if (photo.status === 'failed') return fail(photo.error || MSG_PROCESS, false)
      await deps.sleep(pollMs, signal)
      if (!live()) return
      const r = await deps.get(init.photoId, signal)
      if (!live()) return
      // A failed read just waits for the next tick.
      if (r.ok) {
        photo = r.data
        item.photo = photo
        if (photo.status === 'ready' || photo.status === 'failed') continue
      }
      if (deps.now() - start >= pollMaxMs) {
        set(item, { state: 'processing', message: MSG_TIMEOUT, settled: true })
        emit(photo)
        return
      }
    }
    set(item, { state: 'done', message: '', photo })
    emit(photo)
  }

  function emit(p: OwnerPhoto) {
    for (const cb of listeners) cb(p)
  }

  function check(file: File): string {
    if (!(ACCEPT as readonly string[]).includes(file.type)) return MSG_TYPE
    if (file.size > MAX_BYTES) return MSG_SIZE
    return ''
  }

  return {
    items,
    add(files) {
      if (life.signal.aborted) return
      for (const f of files) {
        const reason = check(f)
        items.push({
          key: `u${++seq}`,
          file: markRaw(f),
          state: reason ? 'rejected' : 'queued',
          progress: 0,
          message: reason,
          photo: null,
          retryable: false,
          settled: false,
        })
      }
      syncUnload()
      pump()
    },
    retry(key) {
      const item = items.find((i) => i.key === key)
      if (!item || item.state !== 'failed' || !item.retryable || life.signal.aborted) return
      set(item, { state: 'queued', message: '', progress: 0, retryable: false })
      pump()
    },
    clearFinished() {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!
        if (it.state === 'done' || it.state === 'duplicate' || it.settled) items.splice(i, 1)
      }
    },
    dispose() {
      life.abort()
      syncUnload()
    },
    onDone(cb) {
      listeners.push(cb)
    },
  }
}

/** 「N 张完成，M 张失败，K 张进行中」, zero parts left out; '' with no items. */
export function summarize(items: Readonly<QueueItem[]>): string {
  let done = 0
  let failed = 0
  let busy = 0
  for (const i of items) {
    if (i.state === 'done' || i.state === 'duplicate' || i.settled) done++
    else if (i.state === 'failed' || i.state === 'rejected') failed++
    else busy++
  }
  const parts: string[] = []
  if (done) parts.push(`${done} 张完成`)
  if (failed) parts.push(`${failed} 张失败`)
  if (busy) parts.push(`${busy} 张进行中`)
  return parts.join('，')
}
