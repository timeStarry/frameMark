import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, RouterView, type HistoryState, type Router } from 'vue-router'
import { createAppRouter } from '../router'
import { collectionCache } from './collectionCache'
import { card, collection, fullFrame, neighbors, photo } from '../viewer/testFixtures'
import type { Collection, Neighbors } from '../api/types'

type Reply = { status: number; body?: unknown } | 'network'

let routes: Record<string, Reply>
let calls: string[]

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  routes = {}
  calls = []
  collectionCache.clear()
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url)
    const path = url.split('?')[0]!
    const r = routes[path] ?? { status: 404, body: { error: '未找到。' } }
    if (r === 'network') throw new TypeError('Failed to fetch')
    return json(r.status, r.body ?? {})
  })
  sessionStorage.clear()
  document.title = 'Markr'
})

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function col(id: string, title: string, owner = { id: 'u1', name: '阿树' }, n = 3): Collection {
  return collection(
    Array.from({ length: n }, (_, i) => fullFrame(photo(`${id}p${i + 1}`))),
    { id, title, owner },
  )
}

function serve(c: Collection, nb: Neighbors | Reply) {
  routes[`/api/collections/${c.id}`] = { status: 200, body: c }
  routes[`/api/collections/${c.id}/neighbors`] = 'wall' in (nb as object) ? { status: 200, body: nb } : (nb as Reply)
}

async function open(url: string, state?: HistoryState): Promise<Router> {
  const router = createAppRouter(createMemoryHistory())
  if (state) {
    await router.push('/')
    await router.push({ path: url.split('?')[0]!, query: Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? '')), state })
  } else {
    await router.push(url)
  }
  await router.isReady()
  w = mount(defineComponent({ render: () => h(RouterView) }), { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  await flushPromises()
  return router
}

const A = col('a', '海边')
const B = col('b', '山中', { id: 'u2', name: '林' })
const Z = col('z', '城里')
const nbA = neighbors({ wall: 'square', next: card('b', '山中', '林', 'u2'), prev: card('z', '城里'), strip: [card('z', '城里'), card('a', '海边'), card('b', '山中')] })

describe('CollectionRoute', () => {
  it('shows a black screen while loading, then the viewer', async () => {
    let release!: () => void
    vi.stubGlobal('fetch', (url: string) =>
      new Promise<Response>((res) => {
        release = () => res(url.includes('neighbors') ? json(200, neighbors()) : json(200, A))
      }),
    )
    const router = createAppRouter(createMemoryHistory())
    await router.push('/c/a')
    w = mount(defineComponent({ render: () => h(RouterView) }), { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    expect(w.find('.route').exists()).toBe(true)
    expect(w.find('.viewer').exists()).toBe(false)
    expect(w.text()).toBe('')
    release()
    await flushPromises()
  })

  it('renders the viewer and sets the document title', async () => {
    serve(A, nbA)
    await open('/c/a')
    expect(w!.find('.viewer').exists()).toBe(true)
    expect(document.title).toBe('海边 · 阿树 — Markr')
  })

  it('restores the title when leaving', async () => {
    serve(A, nbA)
    const router = await open('/c/a')
    await router.push('/')
    await flushPromises()
    expect(document.title).toBe('Markr')
  })

  it('shows the missing screen on 404', async () => {
    await open('/c/nope')
    expect(w!.text()).toContain('这组照片不存在或已不再公开')
    expect(w!.find('a[href="/"]').exists()).toBe(true)
    expect(w!.text()).not.toContain('重试')
  })

  it('shows a retry on network errors, and retrying loads', async () => {
    routes['/api/collections/a'] = 'network'
    await open('/c/a')
    expect(w!.text()).toContain('重试')
    serve(A, nbA)
    await w!.findAll('button').find((b) => b.text() === '重试')!.trigger('click')
    await flushPromises()
    await flushPromises()
    expect(w!.find('.viewer').exists()).toBe(true)
  })

  it('clamps an out-of-range f to the end frame', async () => {
    serve(A, nbA)
    await open('/c/a?f=99')
    // 3 frames + end frame: the 4th slot is current.
    expect(w!.find('[data-frame="4"]').attributes('aria-hidden')).toBeUndefined()
  })

  it('still shows the collection when neighbors fail', async () => {
    serve(A, { status: 500 })
    await open('/c/a')
    expect(w!.find('.viewer').exists()).toBe(true)
    expect(w!.find('.edge-bottom button').exists()).toBe(false)
  })

  it('writes the server wall back into the URL with replace', async () => {
    serve(A, { ...nbA, wall: 'square' })
    const router = await open('/c/a?wall=bogus')
    expect(router.currentRoute.value.query.wall).toBe('square')
  })

  it('replaces f when the frame changes', async () => {
    serve(A, nbA)
    const router = await open('/c/a')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(router.currentRoute.value.query.f).toBe('2')
  })

  it('navigates to next with push, keeping the wall, served from the prefetch cache', async () => {
    serve(A, nbA)
    serve(B, neighbors({ wall: 'square', prev: card('a', '海边') }))
    serve(Z, neighbors({ wall: 'square' }))
    const router = await open('/c/a?wall=square')
    expect(calls).toContain('/api/collections/b')
    const before = calls.filter((c) => c === '/api/collections/b').length
    const len = (router.options.history as { state: unknown; location: string }).location
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await flushPromises()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/c/b')
    expect(router.currentRoute.value.query.wall).toBe('square')
    expect(len).toContain('/c/a')
    expect(calls.filter((c) => c === '/api/collections/b').length).toBe(before)
    expect(document.title).toBe('山中 · 林 — Markr')
    // Cross-author: the new author is announced.
    expect(w!.find('[aria-live]').text()).toBe('林 的「山中」')
    router.back()
    await flushPromises()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/c/a')
  })

  it('remembers the last viewed collection per wall when leaving', async () => {
    serve(A, nbA)
    const router = await open('/c/a?wall=square')
    await router.push('/')
    await flushPromises()
    expect(sessionStorage.getItem('markr:lastViewed:square')).toBe('a')
  })

  it('exit goes home when not entered from a wall', async () => {
    serve(A, nbA)
    const router = await open('/c/a')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('exit goes back past viewer pushes when entered from a wall', async () => {
    serve(A, nbA)
    serve(B, neighbors({ wall: 'square' }))
    const router = await open('/c/a?wall=square', { fromWall: true })
    const go = vi.spyOn(router, 'go')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await flushPromises()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/c/b')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(go).toHaveBeenCalledWith(-2)
  })
})
