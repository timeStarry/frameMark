// Test-only helpers for the desk component tests. Never imported by app code.
import type { DeskPhoto } from './sequence'
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
