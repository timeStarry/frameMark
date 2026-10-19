import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { CollectionFields, ExposureChange, OwnerCollection, OwnerCollectionWrite, OwnerFramePhoto } from '../api/types'
import { insertPhotos, insertText, isValid, toInput, type DeskPhoto, type Seq } from './sequence'
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

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  getOwnerCollection.mockReset()
  putCollection.mockReset().mockResolvedValue(ok(write()))
  putFrames.mockReset().mockResolvedValue(ok(write({ updatedAt: 12 })))
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
