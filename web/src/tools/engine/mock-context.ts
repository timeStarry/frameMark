// Test helper: a 2D context that records calls. happy-dom has no canvas.

export interface Call {
  name: string
  args: unknown[]
  /** Context state at the time of the call. */
  font: string
  filter: string
  textAlign: string
  transform: number[]
}

export class MockContext {
  calls: Call[] = []
  font = '10px sans-serif'
  filter = 'none'
  fillStyle: unknown = '#000'
  globalAlpha = 1
  textAlign = 'start'
  textBaseline = 'alphabetic'
  transform = [1, 0, 0, 1, 0, 0]
  private stack: Array<Pick<MockContext, 'font' | 'filter' | 'textAlign' | 'globalAlpha'> & { transform: number[] }> = []

  private log(name: string, args: unknown[]): void {
    this.calls.push({
      name,
      args,
      font: this.font,
      filter: this.filter,
      textAlign: this.textAlign,
      transform: [...this.transform],
    })
  }

  /** Font size in px parsed from the current font. */
  get fontPx(): number {
    return Number.parseFloat(this.font)
  }

  save(): void {
    this.stack.push({
      font: this.font,
      filter: this.filter,
      textAlign: this.textAlign,
      globalAlpha: this.globalAlpha,
      transform: [...this.transform],
    })
    this.log('save', [])
  }

  restore(): void {
    const s = this.stack.pop()
    if (s) Object.assign(this, s)
    this.log('restore', [])
  }

  setTransform(...m: number[]): void {
    this.transform = m
    this.log('setTransform', m)
  }

  scale(...args: number[]): void {
    this.log('scale', args)
  }

  fillRect(...args: number[]): void {
    this.log('fillRect', args)
  }

  clearRect(...args: number[]): void {
    this.log('clearRect', args)
  }

  beginPath(): void {
    this.log('beginPath', [])
  }

  rect(...args: number[]): void {
    this.log('rect', args)
  }

  roundRect(...args: unknown[]): void {
    this.log('roundRect', args)
  }

  clip(): void {
    this.log('clip', [])
  }

  drawImage(...args: unknown[]): void {
    this.log('drawImage', args)
  }

  fillText(...args: unknown[]): void {
    this.log('fillText', args)
  }

  measureText(text: string): { width: number } {
    // Every code point is 0.6 em wide.
    return { width: Array.from(text).length * this.fontPx * 0.6 }
  }

  createLinearGradient(...args: number[]): { addColorStop: (o: number, c: string) => void } {
    this.log('createLinearGradient', args)
    return { addColorStop: () => {} }
  }

  named(name: string): Call[] {
    return this.calls.filter((c) => c.name === name)
  }

  asContext(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D
  }
}

export function fakeBitmap(width: number, height: number): ImageBitmap & { closed: boolean } {
  const b = {
    width,
    height,
    closed: false,
    close() {
      b.closed = true
    },
  }
  return b as unknown as ImageBitmap & { closed: boolean }
}
