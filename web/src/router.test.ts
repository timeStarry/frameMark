import { describe, expect, it } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from './router'

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

  it('resolves /tools and /me to the placeholder', async () => {
    for (const p of ['/tools', '/me']) {
      const r = router.resolve(p)
      const loader = r.matched[0]!.components!.default as () => Promise<{ default: { __name?: string } }>
      const mod = await loader()
      expect(mod.default.__name).toBe('Placeholder')
    }
  })

  it('no longer ships Home.vue', () => {
    expect(Object.keys(import.meta.glob('./routes/Home.vue'))).toEqual([])
    expect(Object.keys(import.meta.glob('./routes/SquareRoute.vue'))).toHaveLength(1)
  })

  it('resolves unknown paths to not-found', () => {
    expect(router.resolve('/no/such/page').name).toBe('not-found')
  })
})
