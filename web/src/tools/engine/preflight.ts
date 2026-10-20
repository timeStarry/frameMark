import { LIMITS } from './limits'
import type { Size } from './limits'
import exifr from 'exifr'

export interface ImageInfo {
  width: number
  height: number
  orientation: number
}

const JPEG = 'image/jpeg'
const PNG = 'image/png'
const WEBP = 'image/webp'
const HEADER_BYTES = 262144

function text(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end))
}

async function pngSize(bytes: Uint8Array, view: DataView): Promise<Size> {
  if (bytes.length < 24 || bytes[0] !== 137 || text(bytes, 1, 4) !== 'PNG') {
    throw new Error('PNG 文件头损坏。')
  }
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  for (let i = 8; i + 12 <= bytes.length; ) {
    const len = view.getUint32(i)
    const name = text(bytes, i + 4, i + 8)
    if (name === 'acTL') throw new Error('暂不支持动画 PNG。')
    if (name === 'IDAT') break
    i += len + 12
  }
  return { width, height }
}

async function jpegSize(bytes: Uint8Array): Promise<Size & { orientation: number }> {
  if (bytes[0] !== 255 || bytes[1] !== 216) {
    throw new Error('JPEG 文件头损坏。')
  }
  let width = 0
  let height = 0
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 255) {
      i++
      continue
    }
    const marker = bytes[i + 1]!
    if (marker === 0xda || marker === 0xd9) break
    const len = (bytes[i + 2]! << 8) + bytes[i + 3]!
    if (len < 2) break
    const sof = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
    if (sof.includes(marker)) {
      height = (bytes[i + 5]! << 8) + bytes[i + 6]!
      width = (bytes[i + 7]! << 8) + bytes[i + 8]!
      break
    }
    i += len + 2
  }
  let orientation = 1
  try {
    orientation = Number(await exifr.orientation(bytes)) || 1
  } catch {
    // Missing EXIF is fine; assume identity.
  }
  return { width, height, orientation }
}

function webpSize(bytes: Uint8Array, view: DataView): Size {
  if (bytes.length < 30 || text(bytes, 0, 4) !== 'RIFF' || text(bytes, 8, 12) !== 'WEBP') {
    throw new Error('WebP 文件头损坏。')
  }
  const kind = text(bytes, 12, 16)
  let width = 0
  let height = 0
  if (kind === 'VP8X') {
    if (bytes[20]! & 2) throw new Error('暂不支持动画 WebP。')
    width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16)
    height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16)
  } else if (kind === 'VP8L') {
    const bits = view.getUint32(21, true)
    width = (bits & 0x3fff) + 1
    height = ((bits >>> 14) & 0x3fff) + 1
  } else if (kind === 'VP8 ') {
    width = view.getUint16(26, true) & 0x3fff
    height = view.getUint16(28, true) & 0x3fff
  }
  return { width, height }
}

export async function preflight(file: File): Promise<ImageInfo> {
  if (![JPEG, PNG, WEBP].includes(file.type)) {
    throw new Error('仅支持 JPEG、PNG、静态 WebP。')
  }
  if (file.size > LIMITS.maxFileBytes) {
    throw new Error('单张图片最多 60 MiB。')
  }

  const bytes = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer())
  const view = new DataView(bytes.buffer)
  let width = 0
  let height = 0
  let orientation = 1

  if (file.type === PNG) {
    const size = await pngSize(bytes, view)
    width = size.width
    height = size.height
  } else if (file.type === JPEG) {
    const size = await jpegSize(bytes)
    width = size.width
    height = size.height
    orientation = size.orientation
  } else {
    const size = webpSize(bytes, view)
    width = size.width
    height = size.height
  }

  if (width * height > LIMITS.maxSourcePixels) {
    throw new Error('图片超过 6000 万像素，请先缩小。')
  }
  if (width < 1 || height < 1) {
    throw new Error('无法识别图片尺寸，请使用标准 JPEG、PNG 或静态 WebP。')
  }

  if (orientation >= 5 && orientation <= 8) {
    return { width: height, height: width, orientation }
  }
  return { width, height, orientation }
}
