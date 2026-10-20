import { preflight } from './preflight'
import type { ImageInfo } from './preflight'
import type { Size } from './limits'

export type DecodedImage = (ImageBitmap | HTMLCanvasElement) & {
  close(): void
}

export function decodeSize(source: Size, maxEdge?: number): Size {
  const ratio = maxEdge ? Math.min(1, maxEdge / Math.max(source.width, source.height)) : 1
  return {
    width: Math.max(1, Math.round(source.width * ratio)),
    height: Math.max(1, Math.round(source.height * ratio)),
  }
}

export async function decode(
  file: File,
  maxEdge?: number,
  onSize?: (size: ImageInfo) => void,
): Promise<DecodedImage> {
  const source = await preflight(file)
  onSize?.(source)
  const target = decodeSize(source, maxEdge)

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image',
        resizeWidth: target.width,
        resizeHeight: target.height,
        resizeQuality: 'high',
      })
      if (bitmap.width !== target.width || bitmap.height !== target.height) {
        bitmap.close()
        throw new Error('浏览器图像缩放不一致')
      }
      return bitmap
    } catch {
      // Local HTML decoder fallback; no manual EXIF rotation.
    }
  }

  const url = URL.createObjectURL(file)
  const image = new Image()
  try {
    image.src = url
    await image.decode()
    if (!image.naturalWidth) throw new Error('图像解码失败。')
    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('画布不可用。')
    ctx.drawImage(image, 0, 0, target.width, target.height)
    return Object.assign(canvas, {
      close() {
        canvas.width = canvas.height = 0
      },
    })
  } finally {
    image.src = ''
    URL.revokeObjectURL(url)
  }
}
