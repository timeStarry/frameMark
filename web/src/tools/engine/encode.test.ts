import { describe, expect, it } from 'vitest'
import { encode } from './encode'

function canvas(blob: Blob | null, type?: string, quality?: number): HTMLCanvasElement {
  return {
    toBlob(cb: BlobCallback, t?: string, q?: number) {
      expect(t).toBe(type)
      expect(q).toBe(quality)
      cb(blob)
    },
  } as HTMLCanvasElement
}

describe('encode', () => {
  it('rejects a null blob and a MIME the browser did not honour', async () => {
    await expect(
      encode(canvas(null, 'image/webp', 0.92), { format: 'image/webp', quality: 92 }),
    ).rejects.toThrow(/编码失败/)
    await expect(
      encode(canvas(new Blob(['x'], { type: 'image/png' }), 'image/webp', 0.8), {
        format: 'image/webp',
        quality: 80,
      }),
    ).rejects.toThrow(/不支持/)
  })

  it('resolves the blob when the MIME matches', async () => {
    const blob = new Blob(['ok'], { type: 'image/jpeg' })
    await expect(
      encode(canvas(blob, 'image/jpeg', 0.92), { format: 'image/jpeg', quality: 92 }),
    ).resolves.toBe(blob)
  })
})
