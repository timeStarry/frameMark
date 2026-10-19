// Test-only helpers for the desk component tests. Never imported by app code.
import { vi } from 'vitest'
import { computed, ref } from 'vue'
import type { CollectionFields } from '../api/types'
import type { DeskPhoto, Seq } from './sequence'
import type { Desk, PhotoProps } from './useDesk'
import { media } from '../viewer/testFixtures'

export function deskPhoto(id: string, title = `标题${id}`): DeskPhoto {
  return { id, title, media: media(id), width: 6000, height: 4000 }
}

/** A minimal DataTransfer: types, setData/getData, effects. */
export class DTStub {
  private data = new Map<string, string>()
  dropEffect = 'none'
  effectAllowed = 'uninitialized'
  get types(): string[] {
    return [...this.data.keys()]
  }
  setData(type: string, v: string) {
    this.data.set(type, v)
  }
  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
  clearData() {
    this.data.clear()
  }
  get files(): File[] {
    return []
  }
}

/** Dispatches a synthetic DragEvent carrying `dt`; returns it for defaultPrevented checks. */
export function drag(el: Element, type: string, dt: DTStub): DragEvent {
  const Ctor = (globalThis as unknown as { DragEvent?: typeof Event }).DragEvent ?? Event
  const e = new Ctor(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(e, 'dataTransfer', { value: dt })
  el.dispatchEvent(e)
  return e
}

/** A Desk stand-in for panel tests: real refs, vi.fn methods. */
export function fakeDesk(init: {
  seq?: Seq
  fields?: Partial<CollectionFields>
  photoProps?: Record<string, PhotoProps>
  errorMessage?: string
}) {
  const seq = ref<Seq>(init.seq ?? [])
  const fields = ref<CollectionFields>({
    title: '海边',
    intro: '',
    visibility: 'private',
    distribute: false,
    originalDownload: false,
    license: null,
    aiDeclaration: null,
    coverPhotoId: null,
    ...init.fields,
  })
  const photoProps = ref<Record<string, PhotoProps>>(init.photoProps ?? {})
  const errorMessage = ref(init.errorMessage ?? '')
  const desk = {
    seq: computed(() => seq.value),
    fields: computed(() => fields.value),
    photoProps: computed(() => photoProps.value),
    errorMessage: computed(() => errorMessage.value),
    applySeq: vi.fn(),
    applyFields: vi.fn(),
    setPhotoMeta: vi.fn(),
    setOverride: vi.fn(),
    clearOverride: vi.fn(),
    remove: vi.fn(async () => true),
  }
  return { desk: desk as unknown as Desk, mocks: desk, seq, fields, photoProps, errorMessage }
}
