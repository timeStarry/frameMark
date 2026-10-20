import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { cardBadge, cardStatus, openCollection } from './open'
import { card } from '../viewer/testFixtures'

let router: Router
beforeEach(async () => {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] })
  await router.push('/')
  await router.isReady()
})

const click = (init: MouseEventInit = {}) => new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })

describe('openCollection', () => {
  it('pushes the viewer route with the wall query and fromWall state', async () => {
    const e = click()
    openCollection(router, 'c 1', 'user:u1', e)
    expect(e.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/c/c%201?wall=user:u1'))
    const state = router.options.history.state as Record<string, unknown>
    expect(state.fromWall).toBe(true)
    expect(state.viewerDepth).toBe(0)
  })

  it('leaves modified, non-left and already-handled clicks to the browser', () => {
    const push = vi.spyOn(router, 'push')
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const e = click(init)
      openCollection(router, 'c1', 'square', e)
      expect(e.defaultPrevented).toBe(false)
    }
    const handled = click()
    handled.preventDefault()
    openCollection(router, 'c1', 'square', handled)
    expect(push).not.toHaveBeenCalled()
  })
})

describe('cardBadge', () => {
  it('labels each status and visibility combination', () => {
    const b = (status?: 'draft' | 'published', visibility?: 'private' | 'unlisted' | 'public') =>
      cardBadge(card('c1', '海边', '阿树', 'u1', { status, visibility }))
    expect(b('draft', 'public')).toBe('草稿')
    expect(b('draft', 'private')).toBe('草稿')
    expect(b('draft', 'unlisted')).toBe('草稿')
    expect(b('published', 'unlisted')).toBe('仅链接')
    expect(b('published', 'private')).toBe('私密')
    expect(b('published', 'public')).toBeNull()
    expect(b(undefined, undefined)).toBeNull()
  })
})

describe('cardStatus', () => {
  it('adds 公开 for a published public collection', () => {
    expect(cardStatus(card('c1', '海边', '阿树', 'u1', { status: 'published', visibility: 'public' }))).toBe('公开')
    expect(cardStatus(card('c1', '海边', '阿树', 'u1', { status: 'draft', visibility: 'public' }))).toBe('草稿')
    expect(cardStatus(card('c1', '海边'))).toBeNull()
  })
})
