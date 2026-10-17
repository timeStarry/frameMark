import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import InfoLayer from './InfoLayer.vue'
import Histogram from './Histogram.vue'
import { collection, EXIF, fullFrame, histogram, pairFrame, photo, textFrame } from './testFixtures'
import type { Frame } from '../api/types'

const col = collection([fullFrame(photo('p1', { exif: EXIF, histogram: histogram(), downloadable: true }))], {
  license: 'CC BY 4.0',
  aiDeclaration: '未使用生成式 AI。',
})

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w })
  window.dispatchEvent(new Event('resize'))
}

describe('Histogram', () => {
  it('does not render when histogram is null', () => {
    const w = mount(Histogram, { props: { histogram: null } })
    expect(w.find('svg').exists()).toBe(false)
    w.unmount()
  })

  it('is an img-role svg and toggles luma / RGB with aria-pressed', async () => {
    const w = mount(Histogram, { props: { histogram: histogram() } })
    const svg = w.get('svg')
    expect(svg.attributes('role')).toBe('img')
    expect(svg.attributes('aria-label')).toBe('直方图')
    const buttons = w.findAll('button')
    expect(buttons[0]!.attributes('aria-pressed')).toBe('true')
    expect(buttons[1]!.attributes('aria-pressed')).toBe('false')
    expect(w.findAll('svg path').length).toBe(1)
    await buttons[1]!.trigger('click')
    expect(buttons[0]!.attributes('aria-pressed')).toBe('false')
    expect(buttons[1]!.attributes('aria-pressed')).toBe('true')
    expect(w.findAll('svg path').length).toBe(3)
    w.unmount()
  })
})

describe('InfoLayer', () => {
  let w: VueWrapper | null = null
  afterEach(() => {
    w?.unmount()
    w = null
    document.body.innerHTML = ''
  })

  function render(frame: Frame | null, width = 1280, open = true) {
    setWidth(width)
    w = mount(InfoLayer, {
      props: { open, collection: col, frame, current: 1, frames: 3 },
      attachTo: document.body,
    })
    return w
  }

  it('is a non-modal dialog with a title', () => {
    const v = render(col.frames[0]!)
    const d = v.get('[role="dialog"]')
    expect(d.attributes('aria-modal')).toBe('false')
    expect(d.attributes('aria-labelledby') || d.attributes('aria-label')).toBeTruthy()
  })

  it('is a 360px side panel at ≥1024 and a bottom drawer below that', async () => {
    const wide = render(col.frames[0]!, 1024)
    expect(wide.get('[role="dialog"]').classes()).toContain('panel')
    wide.unmount()
    const narrow = render(col.frames[0]!, 1023)
    expect(narrow.get('[role="dialog"]').classes()).toContain('drawer')
    expect((narrow.get('[role="dialog"]').element as HTMLElement).style.maxHeight || getComputedStyle(narrow.get('[role="dialog"]').element).maxHeight).toBeTruthy()
  })

  it('lists title, caption, author · collection · n/m, histogram, params, license, AI, download', () => {
    const v = render(col.frames[0]!)
    const t = v.text()
    expect(t).toContain('标题p1')
    expect(t).toContain('图注p1')
    expect(t).toContain('阿树')
    expect(t).toContain('海边')
    expect(t).toMatch(/1\s*\/\s*3/)
    expect(v.find('svg[aria-label="直方图"]').exists()).toBe(true)
    expect(t).toContain('机身')
    expect(t).toContain('X100V')
    expect(t).toContain('CC BY 4.0')
    expect(t).toContain('未使用生成式 AI。')
    const dl = v.get('a[href="/api/photos/p1/original?collection=c1"]')
    expect(dl.text()).toMatch(/原图/)
  })

  it('lets a pair frame switch between its photos', async () => {
    const frame = pairFrame(
      photo('a', { title: '左', exif: EXIF, histogram: histogram() }),
      photo('b', { title: '右', caption: '右注', exif: { iso: 800 }, histogram: null }),
    )
    const v = render(frame)
    expect(v.text()).toContain('左')
    expect(v.text()).not.toContain('右注')
    const next = v.findAll('button').find((b) => /下一|后一张|右/.test(b.text()) || b.attributes('aria-label')?.includes('后'))
    expect(next).toBeTruthy()
    await next!.trigger('click')
    expect(v.text()).toContain('右')
    expect(v.text()).toContain('ISO 800')
    expect(v.find('svg[aria-label="直方图"]').exists()).toBe(false)
  })

  it('shows only collection info on a text frame (no params, histogram or download)', () => {
    const v = render(textFrame('一段文字'))
    const t = v.text()
    expect(t).toContain('海边')
    expect(t).toContain('阿树')
    expect(t).not.toContain('机身')
    expect(t).not.toContain('X100V')
    expect(v.find('svg[aria-label="直方图"]').exists()).toBe(false)
    expect(v.html()).not.toContain('/original')
  })

  it('never renders latitude or longitude, even if stuffed onto the photo', () => {
    const stuffed = fullFrame(
      photo('p1', {
        exif: { ...EXIF, latitude: 31.2, longitude: 121.5 } as typeof EXIF & { latitude: number; longitude: number },
        histogram: histogram(),
      }),
    )
    const v = render(stuffed)
    expect(v.html().toLowerCase()).not.toMatch(/latitude|longitude|纬度|经度/)
  })

  it('moves focus into the dialog on open and back to the trigger on close', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'open'
    document.body.appendChild(trigger)
    trigger.focus()
    setWidth(1280)
    w = mount(InfoLayer, {
      props: { open: false, collection: col, frame: col.frames[0]!, current: 1, frames: 3 },
      attachTo: document.body,
    })
    await w.setProps({ open: true })
    await nextTick()
    expect(w.get('[role="dialog"]').element.contains(document.activeElement)).toBe(true)
    await w.setProps({ open: false })
    await nextTick()
    expect(document.activeElement).toBe(trigger)
  })

  it('a press on the drawer close button never captures the pointer (click stays on the button)', async () => {
    const v = render(col.frames[0]!, 390)
    const head = v.get('header').element as HTMLElement
    const cap = vi.fn()
    head.setPointerCapture = cap
    const btn = v.get('button[aria-label="关闭"]').element
    btn.dispatchEvent(new PointerEvent('pointerdown', { clientY: 400, pointerId: 1, bubbles: true }))
    btn.dispatchEvent(new PointerEvent('pointermove', { clientY: 450, pointerId: 1, bubbles: true }))
    btn.dispatchEvent(new PointerEvent('pointerup', { clientY: 450, pointerId: 1, bubbles: true }))
    expect(cap).not.toHaveBeenCalled()
    await v.get('button[aria-label="关闭"]').trigger('click')
    expect(v.emitted('close')).toHaveLength(1)
  })

  it('a plain press on the drawer header does not capture until it moves', () => {
    const v = render(col.frames[0]!, 390)
    const head = v.get('header').element as HTMLElement
    const cap = vi.fn()
    head.setPointerCapture = cap
    head.dispatchEvent(new PointerEvent('pointerdown', { clientY: 400, pointerId: 1, bubbles: true }))
    expect(cap).not.toHaveBeenCalled()
    head.dispatchEvent(new PointerEvent('pointermove', { clientY: 410, pointerId: 1, bubbles: true }))
    expect(cap).toHaveBeenCalledTimes(1)
  })

  it('paging keys inside the panel scroll its body and never reach the viewer', () => {
    const v = render(col.frames[0]!)
    const body = v.get('.body').element as HTMLElement
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 200 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 1000 })
    const dialog = v.get('[role="dialog"]').element
    const seen: string[] = []
    const onWin = (e: KeyboardEvent) => !e.defaultPrevented && seen.push(e.key)
    window.addEventListener('keydown', onWin)
    try {
      for (const k of ['ArrowDown', 'PageDown', ' ', 'ArrowUp', 'End', 'Home']) {
        dialog.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
        if (k === 'ArrowDown') expect(body.scrollTop).toBe(40)
        if (k === 'PageDown') expect(body.scrollTop).toBe(220)
        if (k === 'End') expect(body.scrollTop).toBe(800)
      }
      expect(body.scrollTop).toBe(0)
      expect(seen).toEqual([])
      // i, Esc and ← → still go to the viewer.
      for (const k of ['i', 'Escape', 'ArrowRight']) dialog.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
      expect(seen).toEqual(['i', 'Escape', 'ArrowRight'])
    } finally {
      window.removeEventListener('keydown', onWin)
    }
  })

  it('Space on a button inside the panel is left to the button', () => {
    const v = render(col.frames[0]!)
    const btn = v.get('button[aria-label="关闭"]').element
    const e = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    btn.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })

  it('emits close from the close button', async () => {
    const v = render(col.frames[0]!)
    await v.get('button[aria-label="关闭"]').trigger('click')
    expect(v.emitted('close')).toHaveLength(1)
  })
})
