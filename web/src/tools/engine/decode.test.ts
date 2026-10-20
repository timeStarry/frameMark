import { afterEach, describe, expect, it, vi } from 'vitest'
import { decode, decodeSize } from './decode'

function png(width: number, height: number): File {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return new File([bytes], 's.png', { type: 'image/png' })
}

describe('decodeSize', () => {
  it('keeps the oriented size when no max edge is set', () => {
    expect(decodeSize({ width: 8000, height: 5000 })).toEqual({ width: 8000, height: 5000 })
    expect(decodeSize({ width: 8000, height: 5000 }, 0)).toEqual({ width: 8000, height: 5000 })
  })

  it('downscales so the long edge matches and never upscales', () => {
    expect(decodeSize({ width: 8000, height: 5000 }, 1600)).toEqual({ width: 1600, height: 1000 })
    expect(decodeSize({ width: 320, height: 240 }, 1600)).toEqual({ width: 320, height: 240 })
    expect(decodeSize({ width: 40, height: 64 }, 20)).toEqual({ width: 13, height: 20 })
  })
})

describe('decode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('asks createImageBitmap for from-image orientation and the scaled size', async () => {
    const close = vi.fn()
    const createImageBitmap = vi.fn(async (_src: File, opts: ImageBitmapOptions) => ({
      width: opts.resizeWidth,
      height: opts.resizeHeight,
      close,
    }))
    vi.stubGlobal('createImageBitmap', createImageBitmap)

    const bitmap = await decode(png(8000, 5000), 1600)
    expect(createImageBitmap).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({
        imageOrientation: 'from-image',
        resizeWidth: 1600,
        resizeHeight: 1000,
        resizeQuality: 'high',
      }),
    )
    expect(bitmap).toMatchObject({ width: 1600, height: 1000 })
    expect(close).not.toHaveBeenCalled()
  })
})
