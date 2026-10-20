import { describe, expect, it } from 'vitest'
import { preflight } from './preflight'

function file(bytes: Uint8Array<ArrayBuffer>, name: string, type: string): File {
  return new File([bytes], name, { type })
}

function png(width: number, height: number, extra?: { animated?: boolean }): Uint8Array<ArrayBuffer> {
  const ihdr = 25
  const extraLen = extra?.animated ? 20 : 0
  const bytes = new Uint8Array(8 + ihdr + extraLen)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  if (extra?.animated) {
    const i = 8 + ihdr
    view.setUint32(i, 8)
    bytes.set([97, 99, 84, 76], i + 4)
  }
  return bytes
}

function jpeg(width: number, height: number, orientation?: number): Uint8Array<ArrayBuffer> {
  const sof = [0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x00]
  if (orientation == null) {
    return Uint8Array.from([0xff, 0xd8, ...sof, 0xff, 0xd9])
  }
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
    orientation & 0xff, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]
  const app1Payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]
  const app1Len = app1Payload.length + 2
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, app1Len >> 8, app1Len & 0xff, ...app1Payload,
    ...sof,
    0xff, 0xd9,
  ])
}

function webp(kind: 'VP8X' | 'VP8L' | 'VP8 ', width: number, height: number, animated = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(30)
  bytes.set([82, 73, 70, 70], 0)
  bytes.set([87, 69, 66, 80], 8)
  bytes.set([...kind].map((c) => c.charCodeAt(0)), 12)
  const view = new DataView(bytes.buffer)
  if (kind === 'VP8X') {
    if (animated) bytes[20] = 2
    const w = width - 1
    const h = height - 1
    bytes[24] = w & 0xff
    bytes[25] = (w >> 8) & 0xff
    bytes[26] = (w >> 16) & 0xff
    bytes[27] = h & 0xff
    bytes[28] = (h >> 8) & 0xff
    bytes[29] = (h >> 16) & 0xff
  } else if (kind === 'VP8L') {
    const bits = (width - 1) | ((height - 1) << 14)
    view.setUint32(21, bits, true)
  } else {
    view.setUint16(26, width, true)
    view.setUint16(28, height, true)
  }
  return bytes
}

describe('preflight', () => {
  it('rejects unsupported types, oversize files and oversize pixels before decode', async () => {
    await expect(preflight(file(new Uint8Array([1]), 'a.gif', 'image/gif'))).rejects.toThrow(
      /仅支持 JPEG、PNG、静态 WebP/,
    )

    const huge = file(new Uint8Array([0xff, 0xd8]), 'big.jpg', 'image/jpeg')
    Object.defineProperty(huge, 'size', { value: 60 * 1024 * 1024 + 1 })
    await expect(preflight(huge)).rejects.toThrow(/60 MiB/)

    await expect(preflight(file(png(10_000, 10_000), 'large.png', 'image/png'))).rejects.toThrow(/6000 万像素/)
    await expect(preflight(file(png(8001, 5000), 'ok-40mp.png', 'image/png'))).resolves.toMatchObject({
      width: 8001,
      height: 5000,
    })
  })

  it('rejects corrupt and animated headers', async () => {
    await expect(preflight(file(new Uint8Array([1, 2, 3, 4]), 'bad.png', 'image/png'))).rejects.toThrow(/PNG 文件头损坏/)
    await expect(preflight(file(new Uint8Array([0, 0]), 'bad.jpg', 'image/jpeg'))).rejects.toThrow(/JPEG 文件头损坏/)
    await expect(preflight(file(new Uint8Array(30), 'bad.webp', 'image/webp'))).rejects.toThrow(/WebP 文件头损坏/)
    await expect(preflight(file(png(8, 8, { animated: true }), 'a.png', 'image/png'))).rejects.toThrow(/动画 PNG/)
    await expect(preflight(file(webp('VP8X', 16, 16, true), 'a.webp', 'image/webp'))).rejects.toThrow(/动画 WebP/)
    await expect(preflight(file(png(0, 10), 'empty.png', 'image/png'))).rejects.toThrow(/无法识别图片尺寸/)
  })

  it('reads JPEG, PNG and WebP sizes and swaps axes for orientation 5–8', async () => {
    await expect(preflight(file(png(320, 240), 's.png', 'image/png'))).resolves.toEqual({
      width: 320,
      height: 240,
      orientation: 1,
    })
    await expect(preflight(file(jpeg(100, 50), 's.jpg', 'image/jpeg'))).resolves.toMatchObject({
      width: 100,
      height: 50,
      orientation: 1,
    })
    await expect(preflight(file(jpeg(100, 50, 6), 'rot.jpg', 'image/jpeg'))).resolves.toEqual({
      width: 50,
      height: 100,
      orientation: 6,
    })
    await expect(preflight(file(webp('VP8X', 40, 30), 'x.webp', 'image/webp'))).resolves.toMatchObject({
      width: 40,
      height: 30,
    })
    await expect(preflight(file(webp('VP8L', 12, 34), 'l.webp', 'image/webp'))).resolves.toMatchObject({
      width: 12,
      height: 34,
    })
    await expect(preflight(file(webp('VP8 ', 20, 10), 'k.webp', 'image/webp'))).resolves.toMatchObject({
      width: 20,
      height: 10,
    })
  })
})
