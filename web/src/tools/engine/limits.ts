export interface Size {
  width: number
  height: number
}

export const LIMITS = Object.freeze({
  maxFileBytes: 60 * 1024 * 1024,
  maxSourcePixels: 60_000_000,
  maxOutputPixels: 16_000_000,
  maxEdge: 8192,
  maxAssets: 12,
  previewEdge: 1600,
  thumbnailEdge: 320,
  historySteps: 50,
  estimatedMemoryBytes: 256 * 1024 * 1024,
})

export function validateWorkingSet(
  sourcePixels: number,
  targetPixels: number,
  assets = 1,
): number {
  const estimate =
    sourcePixels * 4 +
    targetPixels * 8 +
    LIMITS.previewEdge ** 2 * 4 +
    assets * LIMITS.thumbnailEdge ** 2 * 4
  if (estimate > LIMITS.estimatedMemoryBytes) {
    throw new Error('估计处理内存超过 256 MiB，请降低输出尺寸后重试；原图和设置已保留。')
  }
  return estimate
}

export function validateOutput(s: Size): void {
  const pixels = s.width * s.height
  if (
    !Number.isFinite(pixels) ||
    s.width < 1 ||
    s.height < 1 ||
    pixels > LIMITS.maxOutputPixels ||
    Math.max(s.width, s.height) > LIMITS.maxEdge
  ) {
    throw new Error('输出超过限制：最多 1600 万像素，长边 8192 px。请减小导出长边。')
  }
}

// Local editing references only; never credentials, sessions or security tokens.
let localSequence = 0

/** The subset of Crypto that createAssetId uses; injectable for tests. */
export interface IdProvider {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

export function createAssetId(provider: IdProvider | undefined = globalThis.crypto): string {
  try {
    if (typeof provider?.randomUUID === 'function') {
      return provider.randomUUID()
    }
  } catch {
    // Fall through to the local sequence.
  }
  const sequence = (++localSequence).toString(36)
  let entropy = ''
  try {
    if (typeof provider?.getRandomValues === 'function') {
      const bytes = provider.getRandomValues(new Uint8Array(16))
      entropy = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    // Entropy is optional.
  }
  return 'local-' + Date.now().toString(36) + '-' + sequence + (entropy ? '-' + entropy : '')
}
