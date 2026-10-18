import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from 'vitest'
import type { OwnerPhoto, UploadInit } from '../api/types'
import type { WriteResult } from '../api/write'
import type { Result } from '../api/client'
import { createQueue, MAX_BYTES, sleep, summarize, xhrPut, type UploadDeps } from './uploadQueue'

function photo(id: string, over: Partial<OwnerPhoto> = {}): OwnerPhoto {
  return {
    id,
    status: 'processing',
    error: null,
    title: id,
    caption: '',
    width: null,
    height: null,
    format: 'jpeg',
    createdAt: 0,
    publicFields: [],
    histogramPublic: false,
    originalDownload: false,
    exif: null,
    media: null,
    ...over,
  }
}

function init(id: string): UploadInit {
  return {
    photoId: id,
    upload: { url: `https://s3.example/${id}`, method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'x-amz-checksum-sha256': 'x' } },
    expiresAt: 0,
  }
}

const file = (name: string, type = 'image/jpeg', size = 10) =>
  new File([new Uint8Array(size)], name, { type })

/** Lets every pending microtask (and chained awaits) run. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

let clock = 0
let active = 0
let maxActive = 0
let puts: { url: string; headers: Record<string, string>; signal: AbortSignal; resolve: (s: number) => void; onProgress: (p: number) => void }[] = []
let deps: Mocked<UploadDeps>

beforeEach(() => {
  vi.useFakeTimers()
  clock = 0
  active = 0
  maxActive = 0
  puts = []
  deps = {
    hash: vi.fn(async (f: File) => {
      active++
      maxActive = Math.max(maxActive, active)
      return `h-${f.name}`
    }),
    create: vi.fn(async (f: { filename: string }): Promise<WriteResult<UploadInit | OwnerPhoto>> => ({
      ok: true,
      status: 201,
      data: init(`id-${f.filename}`),
    })),
    put: vi.fn(
      (url: string, _m: string, headers: Record<string, string>, _f: File, onProgress: (p: number) => void, signal: AbortSignal) =>
        new Promise<number>((resolve) => puts.push({ url, headers, signal, resolve, onProgress })),
    ),
    complete: vi.fn(async (id: string): Promise<WriteResult<OwnerPhoto>> => ({ ok: true, status: 200, data: photo(id) })),
    get: vi.fn(async (id: string): Promise<Result<OwnerPhoto>> => ({ ok: true, data: photo(id, { status: 'ready' }) })),
    sleep: vi.fn((ms: number, signal: AbortSignal) => {
      clock += ms
      return sleep(ms, signal)
    }),
    now: vi.fn(() => clock),
  }
})

afterEach(() => {
  vi.useRealTimers()
})

/** Wrap get so finishing a file decrements the active counter. */
function trackFinish(q: ReturnType<typeof createQueue>) {
  q.onDone(() => active--)
}

describe('upload queue', () => {
  it('never runs more than 2 files at once', async () => {
    const q = createQueue(deps)
    trackFinish(q)
    q.add([file('a.jpg'), file('b.jpg'), file('c.jpg'), file('d.jpg')])
    await settle()
    expect(puts.length).toBe(2)
    expect(q.items.map((i) => i.state)).toEqual(['uploading', 'uploading', 'queued', 'queued'])
    puts[0]!.resolve(200)
    await settle()
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(q.items[0]!.state).toBe('done')
    expect(puts.length).toBe(3)
    puts[1]!.resolve(200)
    puts[2]!.resolve(200)
    await settle()
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    puts[3]!.resolve(200)
    await settle()
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(q.items.every((i) => i.state === 'done')).toBe(true)
    expect(maxActive).toBe(2)
  })

  it('sends exactly the presigned headers and reports progress', async () => {
    const q = createQueue(deps)
    q.add([file('a.jpg')])
    await settle()
    expect(deps.create).toHaveBeenCalledWith({ filename: 'a.jpg', bytes: 10, sha256: 'h-a.jpg', contentType: 'image/jpeg' })
    expect(puts[0]!.url).toBe('https://s3.example/id-a.jpg')
    expect(puts[0]!.headers).toEqual(init('x').upload.headers)
    puts[0]!.onProgress(0.5)
    expect(q.items[0]!.progress).toBe(0.5)
  })

  it('marks a duplicate without PUT, complete or onDone', async () => {
    deps.create.mockResolvedValue({ ok: true, status: 200, data: photo('old', { status: 'ready' }) })
    const q = createQueue(deps)
    const done = vi.fn()
    q.onDone(done)
    q.add([file('a.jpg')])
    await settle()
    expect(q.items[0]!.state).toBe('duplicate')
    expect(q.items[0]!.message).toBe('已在归档中')
    expect(deps.put).not.toHaveBeenCalled()
    expect(deps.complete).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
  })

  it('rejects unsupported types and oversize files without any request', async () => {
    const q = createQueue(deps)
    q.add([file('a.gif', 'image/gif'), file('b.jpg', 'image/jpeg', MAX_BYTES + 1), file('c.heic', '')])
    await settle()
    expect(q.items.map((i) => [i.state, i.message])).toEqual([
      ['rejected', '不支持此格式（仅 JPEG、PNG、WebP）'],
      ['rejected', '文件超过 60 MB'],
      ['rejected', '不支持此格式（仅 JPEG、PNG、WebP）'],
    ])
    expect(deps.hash).not.toHaveBeenCalled()
    q.retry(q.items[0]!.key)
    await settle()
    expect(q.items[0]!.state).toBe('rejected')
  })

  it('accepts a file of exactly MAX_BYTES', async () => {
    const q = createQueue(deps)
    q.add([file('a.png', 'image/png', MAX_BYTES)])
    await settle()
    expect(q.items[0]!.state).toBe('uploading')
  })

  it('shows the create error message as given', async () => {
    deps.create.mockResolvedValue({ ok: false, status: 413, message: '超过配额' })
    const q = createQueue(deps)
    q.add([file('a.jpg')])
    await settle()
    expect(q.items[0]).toMatchObject({ state: 'failed', message: '超过配额', retryable: true })
  })

  it('fails a non-2xx PUT and retries from create', async () => {
    const q = createQueue(deps)
    const done = vi.fn()
    q.onDone(done)
    q.add([file('a.jpg')])
    await settle()
    puts[0]!.resolve(403)
    await settle()
    expect(q.items[0]).toMatchObject({ state: 'failed', message: '上传失败，请重试', retryable: true })
    expect(deps.complete).not.toHaveBeenCalled()
    q.retry(q.items[0]!.key)
    await settle()
    expect(deps.create).toHaveBeenCalledTimes(2)
    puts[1]!.resolve(204)
    await settle()
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(q.items[0]!.state).toBe('done')
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('treats a network error (status 0) PUT as failed', async () => {
    const q = createQueue(deps)
    q.add([file('a.jpg')])
    await settle()
    puts[0]!.resolve(0)
    await settle()
    expect(q.items[0]).toMatchObject({ state: 'failed', message: '上传失败，请重试' })
  })

  it('shows the complete error message', async () => {
    deps.complete.mockResolvedValue({ ok: false, status: 409, message: '对象不存在' })
    const q = createQueue(deps)
    q.add([file('a.jpg')])
    await settle()
    puts[0]!.resolve(200)
    await settle()
    expect(q.items[0]).toMatchObject({ state: 'failed', message: '对象不存在', retryable: true })
  })

  it('polls until ready and fires onDone once', async () => {
    let n = 0
    deps.get.mockImplementation(async (id: string) => ({ ok: true, data: photo(id, { status: ++n >= 3 ? 'ready' : 'processing' }) }))
    const q = createQueue(deps)
    const done = vi.fn()
    q.onDone(done)
    q.add([file('a.jpg')])
    await settle()
    puts[0]!.resolve(200)
    await settle()
    expect(q.items[0]!.state).toBe('processing')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(q.items[0]!.state).toBe('processing')
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(q.items[0]!.state).toBe('done')
    expect(deps.get).toHaveBeenCalledTimes(3)
    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0]![0]).toMatchObject({ id: 'id-a.jpg', status: 'ready' })
    await vi.advanceTimersByTimeAsync(10000)
    expect(deps.get).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops at a processing failure, not retryable', async () => {
    deps.get.mockImplementation(async (id: string) => ({ ok: true, data: photo(id, { status: 'failed', error: '无法解码图片' }) }))
    const q = createQueue(deps)
    const done = vi.fn()
    q.onDone(done)
    q.add([file('a.jpg'), file('b.jpg')])
    await settle()
    puts[0]!.resolve(200)
    await settle()
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(q.items[0]).toMatchObject({ state: 'failed', message: '无法解码图片', retryable: false })
    expect(done).not.toHaveBeenCalled()
    q.retry(q.items[0]!.key)
    await settle()
    expect(q.items[0]!.state).toBe('failed')
    deps.get.mockImplementation(async (id: string) => ({ ok: true, data: photo(id, { status: 'failed', error: null }) }))
    puts[1]!.resolve(200)
    await settle()
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(q.items[1]!.message).toBe('处理失败')
  })

  it('keeps polling past a failed read and times out as processing', async () => {
    deps.get.mockImplementation(async (id: string) => ({ ok: true, data: photo(id, { status: 'processing' }) }))
    deps.get.mockResolvedValueOnce({ ok: false, status: 0 })
    const q = createQueue(deps, { pollMs: 2000, pollMaxMs: 10000 })
    const done = vi.fn()
    q.onDone(done)
    q.add([file('a.jpg'), file('b.jpg'), file('c.jpg')])
    await settle()
    puts[0]!.resolve(200)
    await settle()
    await vi.advanceTimersByTimeAsync(10000)
    await settle()
    expect(deps.get).toHaveBeenCalledTimes(5)
    expect(q.items[0]).toMatchObject({ state: 'processing', message: '仍在处理，稍后刷新归档查看', settled: true })
    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0]![0]).toMatchObject({ id: 'id-a.jpg', status: 'processing' })
    // The timed-out file frees its slot.
    expect(puts.length).toBe(3)
  })

  it('dispose aborts the put and the sleep, leaving no pending timers', async () => {
    deps.get.mockImplementation(async (id: string) => ({ ok: true, data: photo(id, { status: 'processing' }) }))
    const q = createQueue(deps)
    const done = vi.fn()
    q.onDone(done)
    q.add([file('a.jpg'), file('b.jpg'), file('c.jpg')])
    await settle()
    puts[0]!.resolve(200)
    await settle()
    await vi.advanceTimersByTimeAsync(2000)
    expect(vi.getTimerCount()).toBe(1)
    const putSignal = puts[1]!.signal
    q.dispose()
    expect(putSignal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    puts[1]!.resolve(0)
    await settle()
    await vi.advanceTimersByTimeAsync(200000)
    expect(puts.length).toBe(2)
    expect(done).not.toHaveBeenCalled()
    expect(deps.get).toHaveBeenCalledTimes(1)
    const signal = deps.get.mock.calls[0]![1] as AbortSignal
    expect(signal.aborted).toBe(true)
  })

  it('adds and removes beforeunload while files are unfinished', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const q = createQueue(deps)
    q.add([file('a.jpg')])
    expect(add.mock.calls.filter((c) => c[0] === 'beforeunload').length).toBe(1)
    const handler = add.mock.calls.find((c) => c[0] === 'beforeunload')![1] as (e: Event) => void
    const e = new Event('beforeunload', { cancelable: true })
    handler(e)
    expect(e.defaultPrevented).toBe(true)
    await settle()
    puts[0]!.resolve(200)
    await settle()
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(remove).toHaveBeenCalledWith('beforeunload', handler)
    q.add([file('b.jpg')])
    const handler2 = add.mock.calls.filter((c) => c[0] === 'beforeunload').at(-1)![1]
    q.dispose()
    expect(remove).toHaveBeenCalledWith('beforeunload', handler2)
    add.mockRestore()
    remove.mockRestore()
  })

  describe('a step that throws', () => {
    // No @types/node in this project; type just the two methods we use.
    type Listener = (e: unknown) => void
    const proc = (globalThis as unknown as { process: { on(ev: string, f: Listener): void; off(ev: string, f: Listener): void } }).process
    const boom = () => Promise.reject(new Error('boom'))
    const cases: [string, (d: Mocked<UploadDeps>) => void, number][] = [
      ['create', (d) => d.create.mockImplementationOnce(boom), 0],
      ['put', (d) => d.put.mockImplementationOnce(boom), 0],
      ['complete', (d) => d.complete.mockImplementationOnce(boom), 1],
      ['get', (d) => d.get.mockImplementationOnce(boom), 1],
    ]
    for (const [step, arm, putsBeforeFail] of cases) {
      it(`ends the item failed and retryable when ${step} rejects, and a retry succeeds`, async () => {
        const unhandled: unknown[] = []
        const onUnhandled = (e: unknown) => unhandled.push(e)
        proc.on('unhandledRejection', onUnhandled)
        const remove = vi.spyOn(window, 'removeEventListener')
        try {
          deps.complete.mockImplementation(async (id: string) => ({ ok: true, status: 200, data: photo(id) }))
          arm(deps)
          const q = createQueue(deps)
          const done = vi.fn()
          q.onDone(done)
          q.add([file('a.jpg')])
          await settle()
          for (let i = 0; i < putsBeforeFail; i++) puts[i]!.resolve(200)
          await settle()
          await vi.advanceTimersByTimeAsync(2000)
          await settle()
          expect(q.items[0]).toMatchObject({ state: 'failed', message: '上传失败，请重试', retryable: true })
          expect(summarize(q.items)).toBe('1 张失败')
          expect(remove.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(true)
          expect(done).not.toHaveBeenCalled()

          q.retry(q.items[0]!.key)
          await settle()
          puts.at(-1)!.resolve(200)
          await settle()
          await vi.advanceTimersByTimeAsync(2000)
          await settle()
          expect(q.items[0]!.state).toBe('done')
          expect(done).toHaveBeenCalledTimes(1)
          // Real timers let any unhandled rejection surface before we check.
          vi.useRealTimers()
          await new Promise((r) => setTimeout(r, 0))
          expect(unhandled).toEqual([])
        } finally {
          proc.off('unhandledRejection', onUnhandled)
          remove.mockRestore()
        }
      })
    }

    it('a throw after dispose leaves the item untouched', async () => {
      let reject!: (e: unknown) => void
      deps.create.mockImplementationOnce(() => new Promise((_, r) => (reject = r)))
      const q = createQueue(deps)
      q.add([file('a.jpg')])
      await settle()
      q.dispose()
      reject(new Error('aborted'))
      await settle()
      expect(q.items[0]!.state).toBe('hashing')
      expect(q.items[0]!.message).toBe('')
    })

    it('xhrPut resolves 0 when open throws', async () => {
      class ThrowingXHR {
        upload = {}
        open() {
          throw new DOMException('bad url', 'SyntaxError')
        }
        setRequestHeader() {}
        send() {}
      }
      vi.stubGlobal('XMLHttpRequest', ThrowingXHR)
      try {
        expect(await xhrPut('::', 'PUT', {}, file('a.jpg'), () => {}, new AbortController().signal)).toBe(0)
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  it('clearFinished drops completed items only', async () => {
    deps.create.mockImplementation(async (f: { filename: string }) =>
      f.filename === 'dup.jpg' ? { ok: true, status: 200, data: photo('old') } : { ok: false, status: 500, message: '服务器错误' },
    )
    const q = createQueue(deps)
    q.add([file('dup.jpg'), file('bad.jpg'), file('x.gif', 'image/gif')])
    await settle()
    q.clearFinished()
    expect(q.items.map((i) => i.file.name)).toEqual(['bad.jpg', 'x.gif'])
  })
})

class FakeXHR {
  static last: FakeXHR
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  withCredentials = false
  status = 0
  opened: [string, string] | null = null
  headers: Record<string, string> = {}
  body: unknown
  aborted = false
  constructor() {
    FakeXHR.last = this
  }
  open(m: string, u: string) {
    this.opened = [m, u]
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v
  }
  send(b: unknown) {
    this.body = b
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
}

describe('xhrPut', () => {
  beforeEach(() => vi.stubGlobal('XMLHttpRequest', FakeXHR))
  afterEach(() => vi.unstubAllGlobals())

  it('sends exactly the headers, reports progress and resolves the status', async () => {
    const f = file('a.jpg')
    const progress = vi.fn()
    const p = xhrPut('https://s3/x', 'PUT', { 'Content-Type': 'image/jpeg', 'x-amz-checksum-sha256': 'abc' }, f, progress, new AbortController().signal)
    const x = FakeXHR.last
    expect(x.opened).toEqual(['PUT', 'https://s3/x'])
    expect(x.headers).toEqual({ 'Content-Type': 'image/jpeg', 'x-amz-checksum-sha256': 'abc' })
    expect(x.withCredentials).toBe(false)
    expect(x.body).toBe(f)
    x.upload.onprogress!({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent)
    expect(progress).toHaveBeenCalledWith(0.5)
    x.status = 200
    x.onload!()
    expect(await p).toBe(200)
  })

  it('resolves 0 on error and on abort', async () => {
    const p1 = xhrPut('u', 'PUT', {}, file('a.jpg'), () => {}, new AbortController().signal)
    FakeXHR.last.onerror!()
    expect(await p1).toBe(0)
    const c = new AbortController()
    const p2 = xhrPut('u', 'PUT', {}, file('a.jpg'), () => {}, c.signal)
    const x = FakeXHR.last
    c.abort()
    expect(x.aborted).toBe(true)
    expect(await p2).toBe(0)
  })
})
