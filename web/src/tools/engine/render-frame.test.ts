import { describe, expect, it } from 'vitest'
import { defaultsFrame, type FrameDoc } from './frameDoc'
import { frameTarget, layoutCaption, photoRect, renderFrame } from './render-frame'
import { fakeBitmap, MockContext } from './mock-context'
import { dimensions, outputSize } from './geometry'
import { LIMITS } from './limits'

const source = { width: 4000, height: 3000 }

function doc(partial: Partial<FrameDoc> = {}): FrameDoc {
  return { ...defaultsFrame(), assetId: 'a', ...partial }
}

function blurRadius(ctx: MockContext): number {
  const draw = ctx.named('drawImage').find((c) => c.filter !== 'none')
  expect(draw).toBeTruthy()
  return Number.parseFloat(draw!.filter.replace('blur(', ''))
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Logical box of each fillText call, using the mock's 0.6em glyph width. */
function textBoxes(ctx: MockContext): Box[] {
  return ctx.named('fillText').map((c) => {
    const [text, x, y] = c.args as [string, number, number]
    const px = Number.parseFloat(c.font)
    const width = Array.from(text).length * px * 0.6
    const left = c.textAlign === 'center' ? x - width / 2 : c.textAlign === 'right' ? x - width : x
    return { x: left, y, width, height: px * 1.4 }
  })
}

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

describe('renderFrame blur', () => {
  it('expresses the blur radius in output pixels so preview and export match in ratio', () => {
    const d = doc({ frame: 'blur', blur: 2, border: 10 })
    const logical = dimensions(d, source)
    const preview = new MockContext()
    const exportCtx = new MockContext()
    const previewScale = 1600 / logical.width
    const exportScale = 1
    renderFrame(preview.asContext(), d, fakeBitmap(1600, 1200), source, previewScale)
    renderFrame(exportCtx.asContext(), d, fakeBitmap(4000, 3000), source, exportScale)

    const expected = (3000 * 2) / 100
    expect(blurRadius(exportCtx)).toBeCloseTo(expected * exportScale)
    expect(blurRadius(preview)).toBeCloseTo(expected * previewScale)
    expect(blurRadius(preview) / previewScale).toBeCloseTo(blurRadius(exportCtx) / exportScale)
  })

  it('draws in logical units through setTransform, never ctx.scale', () => {
    const ctx = new MockContext()
    renderFrame(ctx.asContext(), doc({ frame: 'blur' }), fakeBitmap(10, 10), source, 0.25)
    expect(ctx.named('scale')).toHaveLength(0)
    expect(ctx.named('setTransform')[0]!.args).toEqual([0.25, 0, 0, 0.25, 0, 0])
  })
})

describe('renderFrame photo and background', () => {
  it('draws the photo at the padded rect and fills the background for JPEG', () => {
    const ctx = new MockContext()
    const d = doc({ border: 6 })
    renderFrame(ctx.asContext(), d, fakeBitmap(1600, 1200), source, 0.5)
    const pad = 180
    expect(photoRect(d, source)).toEqual({ x: pad, y: pad, width: 4000, height: 3000 })
    expect(ctx.named('fillRect')[0]!.args).toEqual([0, 0, 4360, 3360])
    const photo = ctx.named('drawImage').at(-1)!
    expect(photo.args.slice(1)).toEqual([pad, pad, 4000, 3000])
  })

  it('leaves a transparent solid frame unfilled for PNG', () => {
    const ctx = new MockContext()
    renderFrame(ctx.asContext(), doc({ transparent: true, format: 'image/png' }), fakeBitmap(1, 1), source, 1)
    expect(ctx.named('fillRect')).toHaveLength(0)
  })
})

describe('caption layout', () => {
  it('never draws the caption over the photo rect, for every position', () => {
    const text = 'Morning light over the harbour, a long caption that has to wrap at least once.'
    for (const frame of ['solid', 'gradient', 'blur', 'bottom-bar'] as const) {
      for (let position = 0; position < 9; position++) {
        const d = doc({ frame, text, position, border: 8, size: 2.5 })
        const ctx = new MockContext()
        const result = renderFrame(ctx.asContext(), d, fakeBitmap(10, 10), source, 0.4)
        const photo = photoRect(d, source)
        const boxes = textBoxes(ctx)
        if (result.fits) expect(boxes.length).toBeGreaterThan(0)
        for (const box of boxes) {
          expect(intersects(box, photo), `${frame}/${position}`).toBe(false)
        }
      }
    }
  })

  it('shrinks the font until the caption fits the border band', () => {
    const d = doc({ text: 'x'.repeat(120), position: 7, border: 4, size: 8 })
    const layout = layoutCaption(d, source, new MockContext().asContext(), {})
    expect(layout.fits).toBe(true)
    if (!layout.fits) return
    expect(layout.fontPx).toBeLessThan((3000 * 8) / 100)
    expect(layout.fontPx).toBeGreaterThanOrEqual((3000 * 0.5) / 100)
  })

  it('returns fits:false and draws no text when the frame is 0', () => {
    const ctx = new MockContext()
    const result = renderFrame(ctx.asContext(), doc({ border: 0, text: 'hello' }), fakeBitmap(10, 10), source, 1)
    expect(result).toEqual({ fits: false })
    expect(ctx.named('fillText')).toHaveLength(0)
    // The photo is still drawn.
    expect(ctx.named('drawImage')).toHaveLength(1)
  })

  it('returns fits:false when the text is too long even at the minimum size', () => {
    const ctx = new MockContext()
    const result = renderFrame(
      ctx.asContext(),
      doc({ border: 1, text: '长'.repeat(200).split('').join('\n') }),
      fakeBitmap(10, 10),
      source,
      1,
    )
    expect(result.fits).toBe(false)
    expect(ctx.named('fillText')).toHaveLength(0)
  })

  it('wraps on code points without splitting surrogate pairs', () => {
    const d = doc({ text: '😀'.repeat(80), position: 3, border: 10, size: 6 })
    const layout = layoutCaption(d, source, new MockContext().asContext(), {})
    expect(layout.fits).toBe(true)
    if (!layout.fits) return
    expect(layout.lines.length).toBeGreaterThan(1)
    expect(layout.lines.join('')).toBe('😀'.repeat(80))
    for (const line of layout.lines) expect(line).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('cleans the caption and appends ticked fields', () => {
    const ctx = new MockContext()
    const d = doc({ text: 'a‮b', fields: ['ISO'], position: 7, border: 10 })
    renderFrame(ctx.asContext(), d, fakeBitmap(10, 10), source, 1, { ISO: '400' })
    expect(ctx.named('fillText').map((c) => c.args[0])).toEqual(['ab', '400'])
  })

  it('reports fits:true with no caption', () => {
    expect(renderFrame(new MockContext().asContext(), doc(), fakeBitmap(1, 1), source, 1)).toEqual({ fits: true })
  })

  it('lays out the same in logical units at preview and export scale', () => {
    const d = doc({ text: 'same layout everywhere', position: 8, border: 6 })
    const a = new MockContext()
    const b = new MockContext()
    renderFrame(a.asContext(), d, fakeBitmap(1, 1), source, 0.3)
    renderFrame(b.asContext(), d, fakeBitmap(1, 1), source, 1)
    expect(a.named('fillText').map((c) => c.args)).toEqual(b.named('fillText').map((c) => c.args))
  })
})

describe('frameTarget', () => {
  it('auto-sizes a 20 MP photo with a 6% frame to at most 16 MP', () => {
    const d = doc({ border: 6 })
    const t = frameTarget(d, { width: 5472, height: 3648 })
    expect(t.logical).toEqual({ width: 5910, height: 4086 })
    expect(t.scaledDown).toBe(true)
    expect(t.output.width * t.output.height).toBeLessThanOrEqual(LIMITS.maxOutputPixels)
    expect(Math.max(t.output.width, t.output.height)).toBeLessThanOrEqual(LIMITS.maxEdge)
    expect(t.output).toEqual(outputSize(t.logical, 4810))
    expect(t.scale).toBeCloseTo(t.output.width / t.logical.width)
  })

  it('keeps a 12 MP photo at full size and honours an explicit long edge', () => {
    const d = doc({ border: 6 })
    expect(frameTarget(d, source)).toMatchObject({ scaledDown: false, scale: 1, output: { width: 4360, height: 3360 } })
    expect(frameTarget({ ...d, longEdge: 2180 }, source).output).toEqual({ width: 2180, height: 1680 })
  })

  it('gives the preview size when asked', () => {
    const t = frameTarget(doc(), source, LIMITS.previewEdge)
    expect(Math.max(t.output.width, t.output.height)).toBe(1600)
  })
})
