// Shared harness for the wall route tests: fetch stub keyed by path+query,
// a controllable IntersectionObserver and a scrollIntoView spy.
import { vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, RouterView, type Router } from 'vue-router'
import { createAppRouter } from '../router'

export type Reply = { status: number; body?: unknown } | 'network' | Promise<{ status: number; body?: unknown }>

export const env = {
  routes: {} as Record<string, Reply>,
  calls: [] as string[],
  observers: [] as FakeIO[],
  scrolled: [] as string[],
}

export class FakeIO {
  targets: Element[] = []
  constructor(public cb: IntersectionObserverCallback, public options?: IntersectionObserverInit) {
    env.observers.push(this)
  }
  observe(el: Element) {
    this.targets.push(el)
  }
  unobserve() {}
  disconnect() {
    this.targets = []
  }
  fire() {
    this.cb(this.targets.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry), this as unknown as IntersectionObserver)
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const originalScroll = HTMLElement.prototype.scrollIntoView

export function setup(withIO = true) {
  env.routes = {}
  env.calls = []
  env.observers = []
  env.scrolled = []
  vi.stubGlobal('fetch', async (url: string) => {
    env.calls.push(url)
    const r = env.routes[url] ?? env.routes[url.split('?')[0]!] ?? { status: 404, body: { error: '未找到。' } }
    if (r === 'network') throw new TypeError('Failed to fetch')
    const v = await r
    return json(v.status, v.body ?? {})
  })
  if (withIO) vi.stubGlobal('IntersectionObserver', FakeIO)
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    env.scrolled.push(this.dataset.cardId ?? '')
  } as typeof originalScroll
  sessionStorage.clear()
  document.title = 'Markr'
}

let w: VueWrapper | null = null
export function teardown() {
  w?.unmount()
  w = null
  vi.unstubAllGlobals()
  HTMLElement.prototype.scrollIntoView = originalScroll
  document.body.innerHTML = ''
}

export async function open(url: string, router = createAppRouter(createMemoryHistory())): Promise<{ router: Router; w: VueWrapper }> {
  await router.push(url)
  await router.isReady()
  w = mount(defineComponent({ render: () => h(RouterView) }), { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  await flushPromises()
  return { router, w }
}

/** Unmount the current wrapper (as a full page change would). */
export function close() {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
}

export function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

export const focusedCardId = () => (document.activeElement as HTMLElement | null)?.dataset.cardId ?? null
export const cardIds = (root: { findAll(s: string): { attributes(n: string): string | undefined }[] }) =>
  root.findAll('[data-card-id]').map((e) => e.attributes('data-card-id'))
