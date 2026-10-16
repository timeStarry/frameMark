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

  it('resolves / to home', () => {
    expect(router.resolve('/').name).toBe('home')
  })

  it('resolves unknown paths to not-found', () => {
    expect(router.resolve('/no/such/page').name).toBe('not-found')
  })
})
