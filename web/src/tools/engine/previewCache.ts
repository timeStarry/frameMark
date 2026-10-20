import { decode, type DecodedImage } from './decode'
import { LIMITS } from './limits'

export type Decoder = (file: File, maxEdge?: number) => Promise<DecodedImage>

/**
 * Preview bitmaps keyed by asset id: each asset is decoded once at preview
 * size while it is in use, so parameter changes only redraw.
 */
export class PreviewCache {
  private ready = new Map<string, DecodedImage>()
  private pending = new Map<string, Promise<DecodedImage>>()

  constructor(
    private readonly decoder: Decoder = decode,
    private readonly maxEdge: number = LIMITS.previewEdge,
  ) {}

  get size(): number {
    return this.ready.size + this.pending.size
  }

  previewBitmap(id: string, file: File): Promise<DecodedImage> {
    const hit = this.ready.get(id)
    if (hit) return Promise.resolve(hit)
    const inFlight = this.pending.get(id)
    if (inFlight) return inFlight

    const job = this.decoder(file, this.maxEdge).then(
      (bitmap) => {
        if (this.pending.get(id) !== job) {
          // Evicted or disposed while decoding.
          bitmap.close()
          throw new DOMException('已取消', 'AbortError')
        }
        this.pending.delete(id)
        this.ready.set(id, bitmap)
        return bitmap
      },
      (error: unknown) => {
        if (this.pending.get(id) === job) this.pending.delete(id)
        throw error
      },
    )
    this.pending.set(id, job)
    return job
  }

  evict(id: string): void {
    this.ready.get(id)?.close()
    this.ready.delete(id)
    this.pending.delete(id)
  }

  dispose(): void {
    for (const bitmap of this.ready.values()) bitmap.close()
    this.ready.clear()
    this.pending.clear()
  }
}
