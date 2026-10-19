import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { CollectionFields, ExposureChange, FrameInput, OwnerCollection, OwnerCollectionWrite, OwnerFramePhoto } from '../api/types'
import { insertPhotos, insertText, isValid, remove, setText, toInput, type DeskPhoto, type Seq } from './sequence'
import type { Backup } from './backup'

const {
  getOwnerCollection,
  putCollection,
  putFrames,
  putOverride,
  putPhotoMeta,
  exposureCheck,
  publishDryRun,
  publish,
  unpublish,
  deleteCollection,
} = vi.hoisted(() => ({
  getOwnerCollection: vi.fn(),
  putCollection: vi.fn(),
  putFrames: vi.fn(),
  putOverride: vi.fn(),
  putPhotoMeta: vi.fn(),
  exposureCheck: vi.fn(),
  publishDryRun: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
  deleteCollection: vi.fn(),
}))

vi.mock('../api/desk', () => ({
  getOwnerCollection,
  putCollection,
  putFrames,
  putOverride,
  putPhotoMeta,
  exposureCheck,
  publishDryRun,
  publish,
  unpublish,
  deleteCollection,
}))

vi.mock('../api/session', () => ({
  onIdentityChange: () => () => {},
}))

import { useDesk } from './useDesk'

const CHANGES: ExposureChange[] = [{ kind: 'photos', detail: '加入了一张照片' }]

function photo(id: string, extra: Partial<OwnerFramePhoto> = {}): OwnerFramePhoto {
  return {
    id,
    title: id,
    caption: '',
    width: 10,
    height: 10,
    media: null,
    exif: { iso: 100 },
    histogram: null,
    attribution: null,
    downloadable: false,
    publicFields: ['iso'],
    histogramPublic: false,
    override: null,
    ...extra,
  }
}

function owner(over: Partial<OwnerCollection> = {}): OwnerCollection {
  const p1 = photo('p1')
  return {
    id: 'c1',
    title: '海边',
    intro: '',
    owner: { id: 'u1', name: '我' },
    license: null,
    aiDeclaration: null,
    originalDownload: false,
    cover: p1,
    publishedAt: null,
    status: 'draft',
    visibility: 'private',
    distribute: false,
    updatedAt: 10,
    frames: [{ layout: 'full', matteRatio: null, text: null, photos: [p1] }],
    ...over,
  }
}

function write(over: Partial<OwnerCollectionWrite> = {}): OwnerCollectionWrite {
  return {
    id: 'c1',
    title: '海边',
    intro: '',
    status: 'draft',
    visibility: 'private',
    distribute: false,
    originalDownload: false,
    license: null,
    aiDeclaration: null,
    coverPhotoId: 'p1',
    wallRank: 0,
    publishedAt: null,
    createdAt: 1,
    updatedAt: 11,
    frames: [],
    ...over,
  }
}

function ok<T>(data: T) {
  return { ok: true as const, status: 200, data }
}

function deskPhoto(id: string): DeskPhoto {
  return { id, title: id, media: null, width: 10, height: 10 }
}

function fieldsOf(c: OwnerCollection): CollectionFields {
  return {
    title: c.title,
    intro: c.intro,
    visibility: c.visibility,
    distribute: c.distribute,
    originalDownload: c.originalDownload,
    license: c.license,
    aiDeclaration: c.aiDeclaration,
    coverPhotoId: c.cover?.id ?? null,
  }
}

function snapshot(seq: Seq, fields: CollectionFields) {
  return JSON.parse(JSON.stringify({ seq, fields })) as { seq: Seq; fields: CollectionFields }
}

async function load(c: OwnerCollection) {
  getOwnerCollection.mockResolvedValue({ ok: true, data: c })
  loaded.status = c.status
  const id = ref(c.id)
  const d = useDesk(id)
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
  expect(d.state.value).toBe('ready')
  return d
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
  await Promise.resolve()
}

// Default write responses echo the loaded status, as the server does.
const loaded: { status: 'draft' | 'published' } = { status: 'draft' }

beforeEach(() => {
  loaded.status = 'draft'
  vi.useFakeTimers()
  localStorage.clear()
  getOwnerCollection.mockReset()
  putCollection.mockReset().mockImplementation(async () => ok(write({ status: loaded.status })))
  putFrames.mockReset().mockImplementation(async () => ok(write({ status: loaded.status, updatedAt: 12 })))
  putOverride.mockReset().mockResolvedValue(ok({ collectionId: 'c1', photoId: 'p1', publicFields: [], histogramPublic: null, updatedAt: 13 }))
  putPhotoMeta.mockReset().mockResolvedValue(
    ok({
      id: 'p1',
      status: 'ready',
      error: null,
      title: '',
      caption: '',
      width: 10,
      height: 10,
      format: 'jpeg',
      createdAt: 1,
      publicFields: [],
      histogramPublic: false,
      originalDownload: false,
      exif: null,
      media: null,
      collections: [{ id: 'c1', updatedAt: 14 }],
    }),
  )
  exposureCheck.mockReset().mockResolvedValue(ok({ widens: false, changes: [] }))
  publishDryRun.mockReset().mockResolvedValue(ok({ photos: 1, publicFields: [], histogram: false, originalDownload: false, visibility: 'private', inSquare: false }))
  publish.mockReset().mockResolvedValue(ok(write({ status: 'published', updatedAt: 20 })))
  unpublish.mockReset().mockResolvedValue(ok(write({ status: 'draft', updatedAt: 21 })))
  deleteCollection.mockReset().mockResolvedValue({ ok: true, status: 204, data: undefined })
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('useDesk load', () => {
  it('loads the owner collection into ready state', async () => {
    const d = await load(owner())
    expect(d.collection.value?.id).toBe('c1')
    expect(d.fields.value.title).toBe('海边')
    expect(d.seq.value).toHaveLength(1)
    expect(d.saveState.value).toBe('saved')
    expect(d.backupOffer.value).toBeNull()
    expect(d.exposure.value).toBeNull()
    expect(d.conflict.value).toBeNull()
  })

  it('is missing on 404 and error on other failures', async () => {
    getOwnerCollection.mockResolvedValue({ ok: false, status: 404 })
    const a = useDesk(ref('gone'))
    await Promise.resolve()
    await nextTick()
    expect(a.state.value).toBe('missing')

    getOwnerCollection.mockResolvedValue({ ok: false, status: 500 })
    const b = useDesk(ref('boom'))
    await Promise.resolve()
    await nextTick()
    expect(b.state.value).toBe('error')
  })
})

describe('draft never calls exposureCheck', () => {
  it('an edit to a draft never calls exposureCheck', async () => {
    const d = await load(owner({ status: 'draft' }))
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    expect(exposureCheck).not.toHaveBeenCalled()
    expect(putFrames).toHaveBeenCalledTimes(1)
  })
})

describe('published exposure check', () => {
  it('a published add photo that widens waits for confirm before any write', async () => {
    exposureCheck.mockResolvedValue(ok({ widens: true, changes: CHANGES }))
    const d = await load(owner({ status: 'published', visibility: 'unlisted' }))
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    expect(exposureCheck).toHaveBeenCalledTimes(1)
    expect(putFrames).not.toHaveBeenCalled()
    expect(d.exposure.value).not.toBeNull()
    expect(d.exposure.value?.changes).toEqual(CHANGES)
    expect(d.seq.value).toHaveLength(2)

    d.exposure.value!.confirm()
    await flush()
    expect(putFrames).toHaveBeenCalledTimes(1)
    expect(d.exposure.value).toBeNull()
  })

  it('cancel restores the exact previous sequence and sends nothing', async () => {
    exposureCheck.mockResolvedValue(ok({ widens: true, changes: CHANGES }))
    const d = await load(owner({ status: 'published' }))
    const before = snapshot(d.seq.value, d.fields.value)
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    expect(putFrames).not.toHaveBeenCalled()
    d.exposure.value!.cancel()
    expect(d.seq.value).toEqual(before.seq)
    expect(d.fields.value).toEqual(before.fields)
    await flush()
    expect(putFrames).not.toHaveBeenCalled()
    expect(putCollection).not.toHaveBeenCalled()
    expect(d.exposure.value).toBeNull()
  })

  it('a narrowing change saves without a dialog', async () => {
    const d = await load(owner({ status: 'published' }))
    d.applySeq(d.seq.value.slice(0, 0), 'structure')
    await flush()
    expect(exposureCheck).not.toHaveBeenCalled()
    expect(putFrames).toHaveBeenCalledTimes(1)
    expect(d.exposure.value).toBeNull()
  })

  it('a published field change that does not widen saves without a dialog', async () => {
    exposureCheck.mockResolvedValue(ok({ widens: false, changes: [] }))
    const d = await load(owner({ status: 'published' }))
    d.applyFields({ ...d.fields.value, visibility: 'unlisted' }, 'exposure')
    await flush()
    expect(exposureCheck).toHaveBeenCalledTimes(1)
    expect(putCollection).toHaveBeenCalledTimes(1)
    expect(d.exposure.value).toBeNull()
  })

  it('text field edits skip the exposure check', async () => {
    const d = await load(owner({ status: 'published' }))
    d.applyFields({ ...d.fields.value, title: '新标题' }, 'field')
    await vi.advanceTimersByTimeAsync(800)
    await Promise.resolve()
    expect(exposureCheck).not.toHaveBeenCalled()
    expect(putCollection).toHaveBeenCalledTimes(1)
  })

  it('cancel of a widening field edit restores the previous fields', async () => {
    exposureCheck.mockResolvedValue(ok({ widens: true, changes: [{ kind: 'visibility', detail: '公开' }] }))
    const d = await load(owner({ status: 'published', visibility: 'unlisted' }))
    const before = snapshot(d.seq.value, d.fields.value)
    d.applyFields({ ...d.fields.value, visibility: 'public' }, 'exposure')
    await flush()
    expect(putCollection).not.toHaveBeenCalled()
    d.exposure.value!.cancel()
    expect(d.fields.value).toEqual(before.fields)
    await flush()
    expect(putCollection).not.toHaveBeenCalled()
  })
})

describe('pending exposure dialog', () => {
  it('a text edit while a widening field dialog is open sends nothing', async () => {
    exposureCheck.mockResolvedValue(ok({ widens: true, changes: [{ kind: 'visibility', detail: '公开' }] }))
    const d = await load(owner({ status: 'published', visibility: 'unlisted' }))
    d.applyFields({ ...d.fields.value, visibility: 'public' }, 'exposure')
    await flush()
    d.applyFields({ ...d.fields.value, title: '趁机' }, 'field')
    await vi.advanceTimersByTimeAsync(1000)
    expect(putCollection).not.toHaveBeenCalled()
    d.exposure.value!.cancel()
    expect(d.fields.value.visibility).toBe('unlisted')
    await vi.advanceTimersByTimeAsync(1000)
    expect(putCollection).not.toHaveBeenCalled()
  })

  it('a structural edit during a dialog is held, then dropped on cancel', async () => {
    exposureCheck.mockResolvedValue(ok({ widens: true, changes: CHANGES }))
    const d = await load(owner({ status: 'published' }))
    const before = snapshot(d.seq.value, d.fields.value)
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    d.applySeq(insertPhotos(d.seq.value, 0, [deskPhoto('p3')]), 'structure')
    await flush()
    expect(putFrames).not.toHaveBeenCalled()
    d.exposure.value!.cancel()
    expect(d.seq.value).toEqual(before.seq)
    await flush()
    expect(putFrames).not.toHaveBeenCalled()
  })
})

describe('conflict', () => {
  it('409 pauses lanes; reload refetches and reset history', async () => {
    putFrames.mockResolvedValue({ ok: false, status: 409, message: '这个合集在别处被修改过。', conflictAt: 99 })
    const d = await load(owner())
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    expect(d.saveState.value).toBe('conflict')
    expect(d.conflict.value).not.toBeNull()

    const newer = owner({ title: '别处', updatedAt: 99, frames: [{ layout: 'full', matteRatio: null, text: null, photos: [photo('p9')] }] })
    getOwnerCollection.mockResolvedValue({ ok: true, data: newer })
    await d.conflict.value!.reload()
    await nextTick()
    expect(d.conflict.value).toBeNull()
    expect(d.fields.value.title).toBe('别处')
    expect(d.seq.value[0]?.photos[0]?.id).toBe('p9')
    expect(d.canUndo.value).toBe(false)
  })

  it('overwrite resends local fields and frames with ifUpdatedAt=null through the exposure check', async () => {
    putFrames.mockResolvedValueOnce({ ok: false, status: 409, message: 'stale', conflictAt: 99 })
    const d = await load(owner({ status: 'published' }))
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    expect(d.conflict.value).not.toBeNull()

    exposureCheck.mockResolvedValue(ok({ widens: false, changes: [] }))
    putFrames.mockResolvedValue(ok(write({ updatedAt: 100 })))
    putCollection.mockResolvedValue(ok(write({ updatedAt: 101 })))
    await d.conflict.value!.overwrite()
    await flush()
    expect(exposureCheck).toHaveBeenCalled()
    expect(putFrames.mock.calls.at(-1)?.[2]).toBeNull()
    expect(putCollection.mock.calls.at(-1)?.[2]).toBeNull()
    expect(d.conflict.value).toBeNull()
  })
})

describe('backup', () => {
  it('the backup offer appears only on a baseUpdatedAt match', async () => {
    const c = owner({ updatedAt: 10 })
    const b: Backup<CollectionFields, ReturnType<typeof toInput>> = {
      baseUpdatedAt: 10,
      savedAt: 20,
      fields: { ...fieldsOf(c), title: '备份标题' },
      frames: toInput([{ key: 'x', layout: 'full', matteRatio: null, text: null, photos: [deskPhoto('p1')] }]),
    }
    localStorage.setItem('markr:desk:c1', JSON.stringify(b))
    const d = await load(c)
    expect(d.backupOffer.value).not.toBeNull()
    d.backupOffer.value!.restore()
    expect(d.fields.value.title).toBe('备份标题')
    expect(d.backupOffer.value).toBeNull()
  })

  it('does not offer a backup whose baseUpdatedAt does not match', async () => {
    localStorage.setItem(
      'markr:desk:c1',
      JSON.stringify({
        baseUpdatedAt: 9,
        savedAt: 20,
        fields: { ...fieldsOf(owner()), title: '旧' },
        frames: toInput([{ key: 'x', layout: 'full', matteRatio: null, text: null, photos: [deskPhoto('p1')] }]),
      }),
    )
    const d = await load(owner({ updatedAt: 10 }))
    expect(d.backupOffer.value).toBeNull()
    expect(d.fields.value.title).toBe('海边')
  })

  it('does not offer a backup whose content matches the server', async () => {
    const c = owner({ updatedAt: 10 })
    localStorage.setItem(
      'markr:desk:c1',
      JSON.stringify({ baseUpdatedAt: 10, savedAt: 20, fields: fieldsOf(c), frames: toInput([{ key: 'x', layout: 'full', matteRatio: null, text: null, photos: [deskPhoto('p1')] }]) }),
    )
    const d = await load(c)
    expect(d.backupOffer.value).toBeNull()
  })
})

describe('undo then save', () => {
  it('undo then save', async () => {
    const d = await load(owner())
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    expect(putFrames).toHaveBeenCalledTimes(1)
    expect(d.seq.value).toHaveLength(2)
    d.undo()
    await flush()
    expect(d.seq.value).toHaveLength(1)
    expect(putFrames).toHaveBeenCalledTimes(2)
    expect(putFrames.mock.calls[1]![1]).toEqual(toInput(d.seq.value))
  })
})

describe('no self-conflict', () => {
  it('two lanes saving back to back each read the latest updatedAt at send time', async () => {
    let resolveFrames!: (v: unknown) => void
    putFrames.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFrames = resolve
        }),
    )
    const d = await load(owner({ updatedAt: 10 }))
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    expect(putFrames).toHaveBeenCalledTimes(1)
    expect(putFrames.mock.calls[0]![2]).toBe(10)

    d.applyFields({ ...d.fields.value, title: '新' }, 'field')
    await vi.advanceTimersByTimeAsync(800)
    // fields still waiting: frames in flight
    expect(putCollection).not.toHaveBeenCalled()

    resolveFrames(ok(write({ updatedAt: 50 })))
    await flush()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(putCollection).toHaveBeenCalledTimes(1)
    expect(putCollection.mock.calls[0]![2]).toBe(50)
  })
})

describe('invalid sequence', () => {
  it('never schedules an invalid sequence and reports a Chinese reason', async () => {
    const d = await load(owner())
    d.applySeq(insertText(d.seq.value, 1), 'structure')
    expect(isValid(d.seq.value).ok).toBe(false)
    await flush()
    expect(putFrames).not.toHaveBeenCalled()
    expect(d.saveState.value).toBe('unsaved')
    expect(d.errorMessage.value).toBe('第 2 帧：文字页不能为空')
  })
})

describe('photo meta and override', () => {
  it('debounces photo meta and uses this collection updatedAt', async () => {
    const d = await load(owner())
    d.setPhotoMeta('p1', { title: '浪', caption: '' })
    await vi.advanceTimersByTimeAsync(400)
    expect(putPhotoMeta).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(400)
    await Promise.resolve()
    expect(putPhotoMeta).toHaveBeenCalledWith('p1', { title: '浪', caption: '' })
  })

  it('a published override that widens waits for confirm', async () => {
    exposureCheck.mockResolvedValue(ok({ widens: true, changes: [{ kind: 'fields', detail: 'iso' }] }))
    const d = await load(owner({ status: 'published' }))
    d.setOverride('p1', { publicFields: ['iso', 'camera'], histogramPublic: false })
    await flush()
    expect(putOverride).not.toHaveBeenCalled()
    expect(d.exposure.value).not.toBeNull()
    d.exposure.value!.confirm()
    await flush()
    expect(putOverride).toHaveBeenCalledTimes(1)
  })
})


// ---------------------------------------------------------------------------
// Fix round 1 (task-6-review.md)

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const frameOf = (p: OwnerFramePhoto) => ({ layout: 'full' as const, matteRatio: null, text: null, photos: [p] })
const sentIds = (call: unknown[] | undefined) => ((call?.[1] as FrameInput[] | undefined) ?? []).flatMap((f) => f.photoIds)
const NOT_WIDE = ok({ widens: false, changes: [] })
const WIDE = ok({ widens: true, changes: CHANGES })

describe('fix round 1: C1 checks gate the state they checked', () => {
  it('C1: undo during an in-flight check is blocked and never sends an unchecked photo', async () => {
    const d = await load(owner({ status: 'published', frames: [frameOf(photo('p1')), frameOf(photo('p2'))] }))
    d.applySeq(remove(d.seq.value, 1), 'structure') // narrows: saved without a check
    await flush()
    expect(putFrames).toHaveBeenCalledTimes(1)

    const check1 = deferred<unknown>()
    exposureCheck.mockReturnValueOnce(check1.promise)
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p3')]), 'structure')
    await flush()
    expect(d.checking.value).toBe(true)
    d.undo()
    d.undo() // would restore p2
    await flush()
    expect(d.seq.value.map((f) => f.photos[0]?.id)).toEqual(['p1', 'p3'])

    check1.resolve(NOT_WIDE)
    await flush()
    for (const c of putFrames.mock.calls) expect(sentIds(c)).not.toContain('p2')
    expect(sentIds(putFrames.mock.calls.at(-1))).toEqual(['p1', 'p3'])
    expect(d.checking.value).toBe(false)
  })
})

describe('fix round 1: C2 publish requires a clean desk', () => {
  it('C2: a failed draft putFrames blocks publish, so its retry is never sent unchecked after publishing', async () => {
    putFrames.mockResolvedValueOnce({ ok: false, status: 500, message: '服务器出错' })
    const d = await load(owner({ status: 'draft' }))
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    expect(d.saveState.value).toBe('error')

    expect(await d.publish()).toBeNull()
    expect(await d.confirmPublish()).toBe(false)
    expect(publishDryRun).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(d.errorMessage.value).toBe('服务器出错')
    expect(putFrames).toHaveBeenCalledTimes(1) // refusal did not resend it

    // The explicit retry goes out while still a draft; only then can publish proceed.
    d.retry()
    await flush()
    expect(putFrames).toHaveBeenCalledTimes(2)
    expect(publish).not.toHaveBeenCalled()
    expect(await d.publish()).not.toBeNull()
    expect(await d.confirmPublish()).toBe(true)
    expect(putFrames).toHaveBeenCalledTimes(2)
    expect(putFrames.mock.invocationCallOrder[1]!).toBeLessThan(publish.mock.invocationCallOrder[0]!)
  })

  it('C2: publish refuses with a Chinese message while a save is pending and flushes first', async () => {
    const d = await load(owner({ status: 'draft' }))
    d.applyFields({ ...d.fields.value, title: '新' }, 'field')
    const m = await d.publish()
    // flush sent the pending title, so the desk is clean and the dry run runs after it
    expect(putCollection).toHaveBeenCalledTimes(1)
    expect(m).not.toBeNull()
    expect(publishDryRun.mock.invocationCallOrder[0]!).toBeGreaterThan(putCollection.mock.invocationCallOrder[0]!)
  })

  it('C2/I6: publish waits for an in-flight save, and confirmPublish needs a dry run first', async () => {
    const f = deferred<unknown>()
    putFrames.mockReturnValueOnce(f.promise)
    const d = await load(owner({ status: 'draft' }))
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    const m = d.publish()
    await flush()
    expect(publishDryRun).not.toHaveBeenCalled()
    f.resolve(ok(write({ updatedAt: 30 })))
    expect(await m).not.toBeNull()
    expect(await d.confirmPublish()).toBe(true)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(putFrames.mock.invocationCallOrder[0]!).toBeLessThan(publishDryRun.mock.invocationCallOrder[0]!)
  })

  it('C2: confirmPublish without a fresh dry run refuses', async () => {
    const d = await load(owner({ status: 'draft' }))
    expect(await d.confirmPublish()).toBe(false)
    expect(publish).not.toHaveBeenCalled()
    expect(await d.publish()).not.toBeNull()
    d.applyFields({ ...d.fields.value, title: '改了' }, 'field')
    await vi.advanceTimersByTimeAsync(800)
    await flush()
    putCollection.mockResolvedValue(ok(write({ updatedAt: 77 })))
    expect(await d.confirmPublish()).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })

  it('C2: an invalid sequence blocks publish', async () => {
    const d = await load(owner({ status: 'draft' }))
    d.applySeq(insertText(d.seq.value, 1), 'structure')
    expect(await d.confirmPublish()).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('fix round 1: C3 an id change isolates the old collection', () => {
  it('C3: writes queued for the old id never reach the new id and late responses are ignored', async () => {
    const c2 = owner({ id: 'c2', title: '山', updatedAt: 500 })
    getOwnerCollection.mockImplementation(async (cid: string) => ({ ok: true, data: cid === 'c2' ? c2 : owner() }))
    const id = ref('c1')
    const d = useDesk(id)
    await flush()
    expect(d.state.value).toBe('ready')

    const f = deferred<unknown>()
    putFrames.mockReturnValueOnce(f.promise)
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    d.applyFields({ ...d.fields.value, title: '旧标题' }, 'field')
    await vi.advanceTimersByTimeAsync(800) // queued behind putFrames on the chain

    id.value = 'c2'
    await nextTick()
    await flush()
    expect(d.collection.value?.id).toBe('c2')

    f.resolve(ok(write({ updatedAt: 999, status: 'published' })))
    await flush()
    await flush()
    for (const c of putCollection.mock.calls) expect(c[0]).not.toBe('c2')
    for (const c of putFrames.mock.calls) expect(c[0]).not.toBe('c2')
    expect(d.collection.value?.updatedAt).toBe(500)
    expect(d.collection.value?.status).toBe('draft')
    expect(d.fields.value.title).toBe('山')
  })
})

describe('fix round 1: C4 restore and field widening', () => {
  function wideBackup(c: OwnerCollection) {
    const b: Backup<CollectionFields, FrameInput[]> = {
      baseUpdatedAt: c.updatedAt,
      savedAt: 1,
      fields: { ...fieldsOf(c), visibility: 'public' },
      frames: [
        { layout: 'full', matteRatio: null, text: null, photoIds: ['p1'] },
        { layout: 'full', matteRatio: null, text: null, photoIds: ['p2'] },
      ],
    }
    localStorage.setItem('markr:desk:c1', JSON.stringify(b))
  }

  it('C4: restore runs one combined check; cancel reverts both and a later text edit carries no widening', async () => {
    exposureCheck.mockResolvedValue(WIDE)
    const c = owner({ status: 'published', visibility: 'unlisted' })
    wideBackup(c)
    const d = await load(c)
    const before = snapshot(d.seq.value, d.fields.value)
    d.backupOffer.value!.restore()
    await flush()
    expect(exposureCheck).toHaveBeenCalledTimes(1)
    expect(exposureCheck.mock.calls[0]![1]).toHaveProperty('collection')
    expect(exposureCheck.mock.calls[0]![1]).toHaveProperty('frames')
    expect(putCollection).not.toHaveBeenCalled()
    expect(putFrames).not.toHaveBeenCalled()

    d.exposure.value!.cancel()
    expect(d.exposure.value).toBeNull()
    expect(d.fields.value).toEqual(before.fields)
    expect(d.seq.value).toEqual(before.seq)

    exposureCheck.mockResolvedValue(NOT_WIDE)
    d.applyFields({ ...d.fields.value, title: '标题' }, 'field')
    await vi.advanceTimersByTimeAsync(800)
    await flush()
    expect(putCollection).toHaveBeenCalledTimes(1)
    expect(putCollection.mock.calls[0]![1].visibility).toBe('unlisted')
    expect(putFrames).not.toHaveBeenCalled()
  })

  it('C4: confirming the combined restore check sends both fields and frames', async () => {
    exposureCheck.mockResolvedValue(WIDE)
    const c = owner({ status: 'published', visibility: 'unlisted' })
    wideBackup(c)
    const d = await load(c)
    d.backupOffer.value!.restore()
    await flush()
    d.exposure.value!.confirm()
    await flush()
    await flush()
    expect(putCollection.mock.calls.at(-1)![1].visibility).toBe('public')
    expect(sentIds(putFrames.mock.calls.at(-1))).toEqual(['p1', 'p2'])
  })

  it("C4: a 'field' call that widens is still checked", async () => {
    exposureCheck.mockResolvedValue(WIDE)
    const d = await load(owner({ status: 'published', visibility: 'unlisted' }))
    d.applyFields({ ...d.fields.value, visibility: 'public' }, 'field')
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(exposureCheck).toHaveBeenCalledTimes(1)
    expect(putCollection).not.toHaveBeenCalled()
    expect(d.exposure.value).not.toBeNull()
  })
})

describe('fix round 1: Important', () => {
  it('I1: a failed check shows error, reverts one step and keeps history', async () => {
    const d = await load(owner({ status: 'published', frames: [frameOf(photo('p1')), frameOf(photo('p2'))] }))
    d.applySeq(remove(d.seq.value, 1), 'structure')
    await flush()
    exposureCheck.mockResolvedValueOnce({ ok: false, status: 500, message: '检查失败' })
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p3')]), 'structure')
    await flush()
    expect(d.seq.value.map((f) => f.photos[0]?.id)).toEqual(['p1'])
    expect(d.saveState.value).toBe('error')
    expect(d.errorMessage.value).toBe('检查失败')
    expect(d.canUndo.value).toBe(true)
    expect(d.canRedo.value).toBe(false)

    d.undo() // back to p1, p2: checked again, not widening
    await flush()
    expect(d.seq.value.map((f) => f.photos[0]?.id)).toEqual(['p1', 'p2'])
    expect(d.saveState.value).toBe('saved')
  })

  it('I2: an empty text frame on a published collection is not checked until it has text', async () => {
    const d = await load(owner({ status: 'published' }))
    d.applySeq(insertText(d.seq.value, 1), 'structure')
    await flush()
    expect(exposureCheck).not.toHaveBeenCalled()
    expect(putFrames).not.toHaveBeenCalled()
    d.applySeq(setText(d.seq.value, 1, '你好'), 'structure')
    await flush()
    expect(exposureCheck).toHaveBeenCalledTimes(1)
    expect(putFrames).toHaveBeenCalledTimes(1)
    expect(d.seq.value).toHaveLength(2)
  })

  it('I3: cancel of a pushed edit restores canUndo/canRedo exactly', async () => {
    exposureCheck.mockResolvedValue(WIDE)
    const d = await load(owner({ status: 'published' }))
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    d.exposure.value!.cancel()
    expect(d.canUndo.value).toBe(false)
    expect(d.canRedo.value).toBe(false)
    d.redo()
    await flush()
    expect(d.seq.value).toHaveLength(1)
    expect(putFrames).not.toHaveBeenCalled()
  })

  it('I3: cancel of a widening undo restores the history and a following undo matches', async () => {
    const d = await load(owner({ status: 'published', frames: [frameOf(photo('p1')), frameOf(photo('p2'))] }))
    d.applySeq(remove(d.seq.value, 1), 'structure')
    await flush()
    const ids = () => d.seq.value.map((f) => f.photos[0]?.id)
    expect([d.canUndo.value, d.canRedo.value]).toEqual([true, false])

    exposureCheck.mockResolvedValue(WIDE)
    d.undo()
    await flush()
    expect(d.exposure.value).not.toBeNull()
    d.exposure.value!.cancel()
    expect(ids()).toEqual(['p1'])
    expect([d.canUndo.value, d.canRedo.value]).toEqual([true, false])

    d.undo()
    await flush()
    expect(ids()).toEqual(['p1', 'p2'])
    expect(d.exposure.value).not.toBeNull()
  })

  it('I4: the overwrite is one-shot; later writes carry ifUpdatedAt again', async () => {
    putCollection.mockResolvedValueOnce({ ok: false, status: 409, message: 'stale', conflictAt: 99 })
    const d = await load(owner())
    d.applyFields({ ...d.fields.value, title: 'A' }, 'field')
    await vi.advanceTimersByTimeAsync(800)
    await flush()
    expect(d.conflict.value).not.toBeNull()
    putCollection.mockResolvedValue(ok(write({ updatedAt: 120 })))
    putFrames.mockResolvedValue(ok(write({ updatedAt: 121 })))
    await d.conflict.value!.overwrite()
    await flush()
    await flush()
    expect(putCollection.mock.calls.at(-1)![2]).toBeNull()
    expect(putFrames.mock.calls.at(-1)![2]).toBeNull()

    d.applyFields({ ...d.fields.value, title: 'B' }, 'field')
    await vi.advanceTimersByTimeAsync(800)
    await flush()
    expect(putCollection.mock.calls.at(-1)![2]).toBe(121)
  })

  it('I5: a structural edit made during a fields check is applied once the check settles', async () => {
    const c = deferred<unknown>()
    exposureCheck.mockReturnValueOnce(c.promise)
    const d = await load(owner({ status: 'published', visibility: 'unlisted', frames: [frameOf(photo('p1')), frameOf(photo('p2'))] }))
    d.applyFields({ ...d.fields.value, visibility: 'public' }, 'exposure')
    await flush()
    d.applySeq(remove(d.seq.value, 1), 'structure')
    c.resolve(NOT_WIDE)
    await flush()
    await flush()
    expect(d.seq.value).toHaveLength(1)
    expect(sentIds(putFrames.mock.calls.at(-1))).toEqual(['p1'])
    expect(putCollection).toHaveBeenCalledTimes(1)
  })

  it('I7: overwrite with widens sends no put before confirm, then exactly one per lane', async () => {
    putFrames.mockResolvedValueOnce({ ok: false, status: 409, message: 'stale', conflictAt: 99 })
    const d = await load(owner({ status: 'published' }))
    d.applySeq(remove(d.seq.value, 0), 'structure')
    // published collections cannot be emptied in reality; the 409 is what matters here
    await flush()
    expect(d.conflict.value).not.toBeNull()
    expect(putFrames).toHaveBeenCalledTimes(1)

    exposureCheck.mockResolvedValue(WIDE)
    await d.conflict.value!.overwrite()
    await flush()
    expect(d.exposure.value).not.toBeNull()
    expect(putFrames).toHaveBeenCalledTimes(1)
    expect(putCollection).not.toHaveBeenCalled()

    d.exposure.value!.confirm()
    await flush()
    await flush()
    expect(putFrames).toHaveBeenCalledTimes(2)
    expect(putCollection).toHaveBeenCalledTimes(1)
    expect(putFrames.mock.calls[1]![2]).toBeNull()
    expect(putCollection.mock.calls[0]![2]).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Fix round 2 (task-6-rereview-1.md)

describe('fix round 2', () => {
  async function conflicted(c: OwnerCollection) {
    putFrames.mockResolvedValueOnce({ ok: false, status: 409, message: 'stale', conflictAt: 99 })
    const d = await load(c)
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    expect(d.conflict.value).not.toBeNull()
    expect(putFrames).toHaveBeenCalledTimes(1)
    return d
  }

  it('N1: overwrite rechecks against the server even when the local copy is a draft', async () => {
    const d = await conflicted(owner({ status: 'draft' }))
    // Another tab published it meanwhile.
    getOwnerCollection.mockResolvedValue({ ok: true, data: owner({ status: 'published', visibility: 'public', updatedAt: 99 }) })
    exposureCheck.mockResolvedValue(WIDE)
    await d.conflict.value!.overwrite()
    await flush()
    expect(getOwnerCollection).toHaveBeenCalledTimes(2)
    expect(exposureCheck).toHaveBeenCalledTimes(1)
    expect(exposureCheck.mock.calls[0]![1]).toHaveProperty('collection')
    expect(exposureCheck.mock.calls[0]![1]).toHaveProperty('frames')
    expect(d.exposure.value).not.toBeNull()
    expect(putFrames).toHaveBeenCalledTimes(1)
    expect(putCollection).not.toHaveBeenCalled()
    expect(d.collection.value?.status).toBe('published')

    d.exposure.value!.cancel()
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(putFrames).toHaveBeenCalledTimes(1)
    expect(putCollection).not.toHaveBeenCalled()
    expect(d.conflict.value).not.toBeNull()
  })

  it('N1: overwrite confirmed after the server recheck sends once per lane without ifUpdatedAt', async () => {
    const d = await conflicted(owner({ status: 'draft' }))
    getOwnerCollection.mockResolvedValue({ ok: true, data: owner({ status: 'published', updatedAt: 99 }) })
    exposureCheck.mockResolvedValue(WIDE)
    await d.conflict.value!.overwrite()
    await flush()
    d.exposure.value!.confirm()
    await flush()
    await flush()
    expect(putFrames).toHaveBeenCalledTimes(2)
    expect(putFrames.mock.calls[1]![2]).toBeNull()
    expect(putCollection).toHaveBeenCalledTimes(1)
    expect(putCollection.mock.calls[0]![2]).toBeNull()
  })

  it('N1: a failed refetch refuses the overwrite and sends nothing', async () => {
    const d = await conflicted(owner({ status: 'draft' }))
    getOwnerCollection.mockResolvedValue({ ok: false, status: 0 })
    await d.conflict.value!.overwrite()
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(exposureCheck).not.toHaveBeenCalled()
    expect(putFrames).toHaveBeenCalledTimes(1)
    expect(putCollection).not.toHaveBeenCalled()
    expect(d.conflict.value).not.toBeNull()
    expect(d.errorMessage.value).toBe('读取最新版本失败，暂时不能覆盖')
  })

  it('m3: restoring while a check is in flight keeps the backup offer', async () => {
    const c = owner({ status: 'published', visibility: 'unlisted' })
    localStorage.setItem(
      'markr:desk:c1',
      JSON.stringify({ baseUpdatedAt: c.updatedAt, savedAt: 1, fields: { ...fieldsOf(c), title: '备份' }, frames: toInput(fromOwnerLike()) }),
    )
    const d = await load(c)
    const chk = deferred<unknown>()
    exposureCheck.mockReturnValueOnce(chk.promise)
    d.applyFields({ ...d.fields.value, visibility: 'public' }, 'exposure')
    await flush()
    expect(d.checking.value).toBe(true)
    d.backupOffer.value!.restore()
    expect(d.backupOffer.value).not.toBeNull()
    expect(d.fields.value.title).toBe('海边')

    chk.resolve(NOT_WIDE)
    await flush()
    d.backupOffer.value!.restore()
    expect(d.backupOffer.value).toBeNull()
    expect(d.fields.value.title).toBe('备份')
  })

  it('m1: the unsaved refusal message clears once everything is saved', async () => {
    putFrames.mockResolvedValueOnce({ ok: false, status: 500, message: '服务器出错' })
    const d = await load(owner({ status: 'draft' }))
    d.applySeq(insertPhotos(d.seq.value, 1, [deskPhoto('p2')]), 'structure')
    await flush()
    expect(await d.publish()).toBeNull()
    d.retry()
    await flush()
    expect(d.saveState.value).toBe('saved')
    expect(d.errorMessage.value).toBe('')
  })

  it('m1: the stale-manifest message clears when the next publish attempt starts', async () => {
    const d = await load(owner({ status: 'draft' }))
    expect(await d.confirmPublish()).toBe(false)
    expect(d.errorMessage.value).toBe('内容有变化，请重新确认发布清单')
    const m = d.publish()
    expect(d.errorMessage.value).toBe('')
    expect(await m).not.toBeNull()
  })
})

function fromOwnerLike(): Seq {
  return [{ key: 'x', layout: 'full', matteRatio: null, text: null, photos: [deskPhoto('p1')] }]
}

// ---------------------------------------------------------------------------
// Task 8a: photoProps and clearOverride

const OVERRIDDEN = () =>
  photo('p1', { publicFields: ['iso', 'camera'], histogramPublic: true, override: { publicFields: ['iso', 'camera'], histogramPublic: true } })
const withP1 = (p: OwnerFramePhoto, over: Partial<OwnerCollection> = {}) =>
  owner({ cover: p, frames: [{ layout: 'full', matteRatio: null, text: null, photos: [p] }], ...over })
const CLEAR = { publicFields: null, histogramPublic: null }

async function settleAll() {
  for (let i = 0; i < 5; i++) await flush()
}

describe('photoProps', () => {
  it('reflects the loaded photos and later meta and override edits', async () => {
    const d = await load(owner())
    expect(d.photoProps.value).toEqual({
      p1: { title: 'p1', caption: '', publicFields: ['iso'], histogramPublic: false, overridden: false },
    })
    d.setPhotoMeta('p1', { title: '浪', caption: '远处' })
    expect(d.photoProps.value.p1).toMatchObject({ title: '浪', caption: '远处' })
    d.setOverride('p1', { publicFields: ['camera'], histogramPublic: true })
    expect(d.photoProps.value.p1).toMatchObject({ publicFields: ['camera'], histogramPublic: true, overridden: true })
  })

  it('marks a loaded override as overridden', async () => {
    const d = await load(withP1(OVERRIDDEN()))
    expect(d.photoProps.value.p1).toMatchObject({ publicFields: ['iso', 'camera'], histogramPublic: true, overridden: true })
  })
})

describe('clearOverride', () => {
  it('published + widening: opens the dialog and writes nothing before confirm', async () => {
    exposureCheck.mockResolvedValue(WIDE)
    const d = await load(withP1(OVERRIDDEN(), { status: 'published', visibility: 'public' }))
    d.clearOverride('p1')
    await flush()
    expect(exposureCheck).toHaveBeenCalledWith('c1', { override: { photoId: 'p1', ...CLEAR } })
    expect(putOverride).not.toHaveBeenCalled()
    expect(d.exposure.value).not.toBeNull()
    putOverride.mockResolvedValue(ok({ collectionId: 'c1', photoId: 'p1', ...CLEAR, updatedAt: 13 }))
    getOwnerCollection.mockResolvedValue(ok(withP1(photo('p1', { publicFields: ['iso', 'lens', 'camera'], histogramPublic: true }), { status: 'published' })))
    d.exposure.value!.confirm()
    await settleAll()
    expect(putOverride).toHaveBeenCalledTimes(1)
    expect(putOverride).toHaveBeenCalledWith('c1', 'p1', CLEAR)
    expect(d.photoProps.value.p1).toMatchObject({ publicFields: ['iso', 'lens', 'camera'], histogramPublic: true, overridden: false })
  })

  it('cancel leaves the override as it was and writes nothing', async () => {
    exposureCheck.mockResolvedValue(WIDE)
    const d = await load(withP1(OVERRIDDEN(), { status: 'published', visibility: 'public' }))
    d.clearOverride('p1')
    await flush()
    d.exposure.value!.cancel()
    await settleAll()
    expect(putOverride).not.toHaveBeenCalled()
    expect(d.exposure.value).toBeNull()
    expect(d.photoProps.value.p1).toMatchObject({ publicFields: ['iso', 'camera'], histogramPublic: true, overridden: true })
  })

  it('a draft skips the exposure check', async () => {
    const d = await load(withP1(OVERRIDDEN()))
    d.clearOverride('p1')
    await settleAll()
    expect(exposureCheck).not.toHaveBeenCalled()
    expect(putOverride).toHaveBeenCalledWith('c1', 'p1', CLEAR)
    expect(d.photoProps.value.p1!.overridden).toBe(false)
  })

  it('a narrowing clear on a published collection opens no dialog', async () => {
    const d = await load(withP1(OVERRIDDEN(), { status: 'published', visibility: 'public' }))
    d.clearOverride('p1')
    await settleAll()
    expect(exposureCheck).toHaveBeenCalledTimes(1)
    expect(d.exposure.value).toBeNull()
    expect(putOverride).toHaveBeenCalledWith('c1', 'p1', CLEAR)
  })
})
