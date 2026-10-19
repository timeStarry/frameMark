import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, type RouteLocationNormalized } from 'vue-router'
import { createAppRouter, scrollTarget } from './router'

describe('router', () => {
  const router = createAppRouter(createMemoryHistory())

  it('resolves /c/:id to the collection route with an id param', () => {
    const r = router.resolve('/c/abc')
    expect(r.name).toBe('collection')
    expect(r.params.id).toBe('abc')
  })

  it('resolves / to the square', () => {
    expect(router.resolve('/').name).toBe('square')
  })

  it('resolves /u/:id and /a/:id to the user and album walls', () => {
    const u = router.resolve('/u/x')
    expect(u.name).toBe('user')
    expect(u.params.id).toBe('x')
    const a = router.resolve('/a/x')
    expect(a.name).toBe('album')
    expect(a.params.id).toBe('x')
  })

  it('resolves /tools to the placeholder', async () => {
    const r = router.resolve('/tools')
    const loader = r.matched[0]!.components!.default as () => Promise<{ default: { __name?: string } }>
    const mod = await loader()
    expect(mod.default.__name).toBe('Placeholder')
  })

  it('resolves /login and the /me workspace lazily', async () => {
    const load = async (p: string, depth: number) => {
      const loader = router.resolve(p).matched[depth]!.components!.default as () => Promise<{
        default: { __name?: string }
      }>
      return (await loader()).default.__name
    }
    expect(router.resolve('/login').name).toBe('login')
    expect(await load('/login', 0)).toBe('LoginRoute')
    for (const [p, name] of [
      ['/me', 'archive'],
      ['/me/collections', 'me-collections'],
      ['/me/settings', 'me-settings'],
    ] as const) {
      const r = router.resolve(p)
      expect(r.name).toBe(name)
      expect(r.matched).toHaveLength(2)
      expect(r.matched.every((m) => m.meta.requiresUser === true)).toBe(true)
      expect(await load(p, 0)).toBe('MeLayout')
    }
  })

  it('resolves the curation desk under /me with requiresUser and props', async () => {
    const r = router.resolve('/me/c/c%201')
    expect(r.name).toBe('desk')
    expect(r.params.id).toBe('c 1')
    expect(r.matched).toHaveLength(2)
    expect(r.matched.every((m) => m.meta.requiresUser === true)).toBe(true)
    expect(r.meta.title).toBe('策展台')
    expect(r.matched[1]!.props.default).toBe(true)
    const loader = r.matched[1]!.components!.default as () => Promise<{ default: { __name?: string } }>
    expect((await loader()).default.__name).toBe('DeskRoute')
  })

  it('no longer ships Home.vue', () => {
    expect(Object.keys(import.meta.glob('./routes/Home.vue'))).toEqual([])
    expect(Object.keys(import.meta.glob('./routes/SquareRoute.vue'))).toHaveLength(1)
  })

  it('resolves unknown paths to not-found', () => {
    expect(router.resolve('/no/such/page').name).toBe('not-found')
  })
})

describe('scrollTarget', () => {
  const r = createAppRouter(createMemoryHistory())
  // resolve() gives the same name/path a navigation would; that is all scrollTarget reads.
  const at = (p: string) => r.resolve(p) as unknown as RouteLocationNormalized

  it('returns the saved position on Back/Forward', () => {
    const saved = { left: 0, top: 812 }
    expect(scrollTarget(at('/u/u1'), at('/a/al1'), saved)).toEqual(saved)
  })

  it('leaves scroll alone for the viewer and for query-only changes', () => {
    expect(scrollTarget(at('/c/x'), at('/u/u1'), null)).toBe(false)
    expect(scrollTarget(at('/c/x?f=2'), at('/c/x?f=1'), null)).toBe(false)
    expect(scrollTarget(at('/?x=1'), at('/'), null)).toBe(false)
  })

  it('scrolls a new wall to the top', () => {
    expect(scrollTarget(at('/a/al1'), at('/u/u1'), null)).toEqual({ top: 0 })
    expect(scrollTarget(at('/'), at('/a/al1'), null)).toEqual({ top: 0 })
  })

  it('scrolls the window itself and returns false', () => {
    const spy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    try {
      expect(r.options.scrollBehavior!(at('/a/al1'), at('/u/u1'), null)).toBe(false)
      expect(spy).toHaveBeenCalledWith({ left: 0, top: 0 })
      spy.mockClear()
      expect(r.options.scrollBehavior!(at('/c/x'), at('/u/u1'), null)).toBe(false)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
