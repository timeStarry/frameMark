import { describe, expect, it, vi } from 'vitest'
import { PreviewCache } from './previewCache'
import { fakeBitmap, MockContext } from './mock-context'
import { defaultsFrame } from './frameDoc'
import { renderFrame } from './render-frame'
import type { DecodedImage } from './decode'

const file = (name: string) => new File([new Uint8Array(4)], name, { type: 'image/jpeg' })

function setup() {
  const made: Array<ReturnType<typeof fakeBitmap>> = []
  const decoder = vi.fn(async (_f: File, edge?: number) => {
    const b = fakeBitmap(edge ?? 100, edge ?? 100)
    made.push(b)
    return b as unknown as DecodedImage
  })
  return { cache: new PreviewCache(decoder), decoder, made }
}

describe('PreviewCache', () => {
  it('decodes each asset once at preview size across 10 parameter changes', async () => {
    const { cache, decoder } = setup()
    const f = file('a.jpg')
    let doc = defaultsFrame()
    for (let i = 0; i < 10; i++) {
      doc = { ...doc, border: i, text: 'x'.repeat(i) }
      const bitmap = await cache.previewBitmap('a', f)
      renderFrame(new MockContext().asContext(), doc, bitmap, { width: 4000, height: 3000 }, 0.3)
    }
    expect(decoder).toHaveBeenCalledTimes(1)
    expect(decoder).toHaveBeenCalledWith(f, 1600)
  })

  it('shares one decode between concurrent requests and keys by asset id', async () => {
    const { cache, decoder } = setup()
    const [x, y] = await Promise.all([cache.previewBitmap('a', file('a')), cache.previewBitmap('a', file('a'))])
    expect(x).toBe(y)
    await cache.previewBitmap('b', file('b'))
    expect(decoder).toHaveBeenCalledTimes(2)
  })

  it('closes on evict and decodes again afterwards', async () => {
    const { cache, decoder, made } = setup()
    await cache.previewBitmap('a', file('a'))
    cache.evict('a')
    expect(made[0]!.closed).toBe(true)
    await cache.previewBitmap('a', file('a'))
    expect(decoder).toHaveBeenCalledTimes(2)
  })

  it('closes every bitmap on dispose, including one still decoding', async () => {
    const { cache, made } = setup()
    await cache.previewBitmap('a', file('a'))
    await cache.previewBitmap('b', file('b'))
    const pending = cache.previewBitmap('c', file('c'))
    cache.dispose()
    await pending.catch(() => {})
    await Promise.resolve()
    expect(made).toHaveLength(3)
    expect(made.every((b) => b.closed)).toBe(true)
    expect(cache.size).toBe(0)
  })

  it('forgets a failed decode so it can be retried', async () => {
    const decoder = vi.fn().mockRejectedValueOnce(new Error('bad')).mockResolvedValue(fakeBitmap(1, 1))
    const cache = new PreviewCache(decoder)
    await expect(cache.previewBitmap('a', file('a'))).rejects.toThrow('bad')
    await expect(cache.previewBitmap('a', file('a'))).resolves.toBeTruthy()
    expect(decoder).toHaveBeenCalledTimes(2)
  })
})
