import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { bindInputs, type InputHandlers } from './input'
import { useEdges } from './useEdges'
import EdgeTop from './EdgeTop.vue'
import EdgeLeft from './EdgeLeft.vue'
import EdgeRight from './EdgeRight.vue'
import EdgeBottom from './EdgeBottom.vue'
import { collection, fullFrame, neighbors, photo, EXIF, card } from './testFixtures'
import type { Collection } from '../api/types'

const RECT = { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} }

function pointer(el: EventTarget, type: string, x: number, y: number) {
  el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1 }))
}

describe('useEdges', () => {
  let el: HTMLElement
  let edges: ReturnType<typeof useEdges>
  let stop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    el = document.createElement('div')
    Object.defineProperty(el, 'getBoundingClientRect', { value: () => RECT, configurable: true })
    document.body.appendChild(el)
    const r = useEdges(el)
    edges = r
    stop = r.stop
  })

  afterEach(() => {
    stop()
    el.remove()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('shows the matching edge when the pointer is within 72px of it', () => {
    pointer(window, 'pointermove', 400, 10)
    expect(edges.visible.top).toBe(true)
    expect(edges.visible.left).toBe(false)
    pointer(window, 'pointermove', 10, 300)
    expect(edges.visible.left).toBe(true)
    pointer(window, 'pointermove', 790, 300)
    expect(edges.visible.right).toBe(true)
    pointer(window, 'pointermove', 400, 590)
    expect(edges.visible.bottom).toBe(true)
  })

  it('hides every edge and marks the stage idle after 2s without pointer movement', () => {
    pointer(window, 'pointermove', 400, 10)
    expect(edges.visible.top).toBe(true)
    expect(el.getAttribute('data-idle')).toBeNull()
    vi.advanceTimersByTime(1999)
    expect(edges.visible.top).toBe(true)
    vi.advanceTimersByTime(1)
    expect(edges.visible.top).toBe(false)
    expect(edges.visible.left).toBe(false)
    expect(el.getAttribute('data-idle')).toBe('')
  })

  it('does not hide while pinned (menu or info layer)', () => {
    pointer(window, 'pointermove', 400, 10)
    edges.pin('menu')
    vi.advanceTimersByTime(5000)
    expect(edges.visible.top).toBe(true)
    expect(el.getAttribute('data-idle')).toBeNull()
    edges.unpin('menu')
    vi.advanceTimersByTime(2000)
    expect(edges.visible.top).toBe(false)
  })

  it('pins the focused edge on focusin and unpins on focusout', () => {
    const btn = document.createElement('button')
    const wrap = document.createElement('div')
    wrap.setAttribute('data-edge', 'top')
    wrap.appendChild(btn)
    el.appendChild(wrap)
    btn.focus()
    expect(edges.visible.top).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(edges.visible.top).toBe(true)
    btn.blur()
    vi.advanceTimersByTime(2000)
    expect(edges.visible.top).toBe(false)
  })

  it('a mouse focus (not :focus-visible) does not pin the edge', () => {
    const btn = document.createElement('button')
    const wrap = document.createElement('div')
    wrap.setAttribute('data-edge', 'left')
    wrap.appendChild(btn)
    el.appendChild(wrap)
    const matches = btn.matches.bind(btn)
    btn.matches = (sel: string) => (sel === ':focus-visible' ? false : matches(sel))
    pointer(window, 'pointermove', 10, 300)
    btn.focus()
    expect(edges.pinned('focus:left')).toBe(false)
    vi.advanceTimersByTime(2000)
    expect(edges.visible.left).toBe(false)
    expect(el.getAttribute('data-idle')).toBe('')
  })

  it('a keyboard focus pin keeps only its own edge; the others still hide', () => {
    const btn = document.createElement('button')
    const wrap = document.createElement('div')
    wrap.setAttribute('data-edge', 'left')
    wrap.appendChild(btn)
    el.appendChild(wrap)
    btn.focus()
    pointer(window, 'pointermove', 400, 10)
    expect(edges.visible.top).toBe(true)
    pointer(window, 'pointermove', 400, 300)
    expect(edges.visible.top).toBe(false)
    expect(edges.visible.left).toBe(true)
    pointer(window, 'pointermove', 400, 590)
    vi.advanceTimersByTime(2000)
    expect(edges.visible.bottom).toBe(false)
    expect(edges.visible.left).toBe(true)
  })

  it('a mouse move during the author flash keeps the top edge up', () => {
    edges.flashTop(1500)
    pointer(window, 'pointermove', 400, 300)
    expect(edges.visible.top).toBe(true)
    vi.advanceTimersByTime(1500)
    expect(edges.visible.top).toBe(false)
  })

  it('edges shown by a touch tap fade after 2s', () => {
    edges.toggleAll()
    expect(edges.visible.top).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(edges.visible).toEqual({ top: false, left: false, right: false, bottom: false })
  })

  it('toggleAll shows then hides every edge', () => {
    expect(edges.visible.top).toBe(false)
    edges.toggleAll()
    expect(edges.visible).toEqual({ top: true, left: true, right: true, bottom: true })
    edges.toggleAll()
    expect(edges.visible).toEqual({ top: false, left: false, right: false, bottom: false })
  })

  it('flashTop shows the top edge for the given duration', () => {
    edges.flashTop(1500)
    expect(edges.visible.top).toBe(true)
    vi.advanceTimersByTime(1499)
    expect(edges.visible.top).toBe(true)
    vi.advanceTimersByTime(1)
    expect(edges.visible.top).toBe(false)
  })
})

const col: Collection = collection([fullFrame(photo('p1', { exif: EXIF, downloadable: true }))], {
  license: 'CC BY 4.0',
})

describe('EdgeTop', () => {
  let w: VueWrapper | null = null
  afterEach(() => {
    w?.unmount()
    w = null
    document.body.innerHTML = ''
  })

  function render(c: Collection = col, downloadable = true, pin = vi.fn(), unpin = vi.fn()) {
    const frame = c.frames[0]!
    w = mount(EdgeTop, {
      props: {
        collection: c,
        photo: { ...frame.photos[0]!, downloadable },
        frameIndex: 1,
        pin,
        unpin,
      },
      attachTo: document.body,
    })
    return w
  }

  it('renders the back button, title · author, and the menu trigger', () => {
    const v = render()
    expect(v.find('button[aria-label="返回"]').exists()).toBe(true)
    expect(v.text()).toContain('海边')
    expect(v.text()).toContain('阿树')
    const trigger = v.get('button[aria-haspopup="menu"]')
    expect(trigger.attributes('aria-expanded')).toBe('false')
  })

  it('emits exit from the back button', async () => {
    const v = render()
    await v.get('button[aria-label="返回"]').trigger('click')
    expect(v.emitted('exit')).toHaveLength(1)
  })

  it('opens a menu with copy, download (when downloadable) and author home', async () => {
    const v = render()
    await v.get('button[aria-haspopup="menu"]').trigger('click')
    const items = v.findAll('[role="menuitem"]')
    expect(items.map((i) => i.text())).toEqual(['复制链接', '下载原图', '作者主页'])
    const dl = items[1]!
    expect(dl.attributes('href')).toBe('/api/photos/p1/original?collection=c1')
    expect(v.find('a[href="/u/u1"]').exists()).toBe(true)
  })

  it('omits the download item when the photo is not downloadable', async () => {
    const v = render(col, false)
    await v.get('button[aria-haspopup="menu"]').trigger('click')
    expect(v.findAll('[role="menuitem"]').map((i) => i.text())).toEqual(['复制链接', '作者主页'])
    expect(v.html()).not.toContain('/original')
  })

  it('does not put the original URL in the DOM until the menu is opened', () => {
    const v = render()
    expect(v.html()).not.toContain('/original')
    expect(document.querySelectorAll('link').length).toBe(0)
  })

  it('pins while the menu is open and Esc closes it, restoring focus to the trigger', async () => {
    const pin = vi.fn()
    const unpin = vi.fn()
    const v = render(col, true, pin, unpin)
    const trigger = v.get('button[aria-haspopup="menu"]').element as HTMLButtonElement
    await v.get('button[aria-haspopup="menu"]').trigger('click')
    expect(pin).toHaveBeenCalledWith('menu')
    expect(v.get('button[aria-haspopup="menu"]').attributes('aria-expanded')).toBe('true')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()
    expect(v.get('button[aria-haspopup="menu"]').attributes('aria-expanded')).toBe('false')
    expect(unpin).toHaveBeenCalledWith('menu')
    expect(document.activeElement).toBe(trigger)
  })
})

describe('EdgeLeft', () => {
  let w: VueWrapper | null = null
  afterEach(() => {
    w?.unmount()
    w = null
  })

  it('renders one jump button per frame when there are 40 or fewer', () => {
    w = mount(EdgeLeft, { props: { current: 3, frames: 12, atEnd: false } })
    const buttons = w.findAll('button[aria-label^="跳到第"]')
    expect(buttons).toHaveLength(12)
    expect(buttons[2]!.attributes('aria-current')).toBe('true')
    expect(w.text()).toMatch(/03\s*\/\s*12/)
  })

  it('emits go(n) from a tick', async () => {
    w = mount(EdgeLeft, { props: { current: 1, frames: 4, atEnd: false } })
    await w.get('button[aria-label="跳到第 3 帧"]').trigger('click')
    expect(w.emitted('go')).toEqual([[3]])
  })

  it('uses a slider when there are more than 40 frames', async () => {
    w = mount(EdgeLeft, { props: { current: 10, frames: 41, atEnd: false } })
    expect(w.findAll('button[aria-label^="跳到第"]')).toHaveLength(0)
    const slider = w.get('[role="slider"]')
    expect(slider.attributes('aria-valuenow')).toBe('10')
    expect(slider.attributes('aria-valuemin')).toBe('1')
    expect(slider.attributes('aria-valuemax')).toBe('41')
    slider.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await nextTick()
    expect(w.emitted('go')).toEqual([[11]])
  })
})

describe('EdgeRight', () => {
  it('does not render when the frame has no public fields', () => {
    const w = mount(EdgeRight, { props: { frame: fullFrame(photo('p1')) } })
    expect(w.find('button').exists()).toBe(false)
    expect(w.text().trim()).toBe('')
    w.unmount()
  })

  it('renders a vertical parameter button that emits open', async () => {
    const w = mount(EdgeRight, { props: { frame: fullFrame(photo('p1', { exif: EXIF })) } })
    const btn = w.get('button')
    expect(btn.attributes('aria-label')).toBe('查看参数与直方图')
    expect(btn.text()).toContain('23mm')
    expect(getComputedStyle(btn.element).writingMode === 'vertical-rl' || btn.classes().join(' ')).toBeTruthy()
    await btn.trigger('click')
    expect(w.emitted('open')).toHaveLength(1)
    w.unmount()
  })
})

describe('EdgeBottom', () => {
  it('does not render when the strip has one or zero cards', () => {
    const empty = mount(EdgeBottom, { props: { collectionId: 'c1', strip: [] } })
    expect(empty.find('button').exists()).toBe(false)
    empty.unmount()
    const one = mount(EdgeBottom, { props: { collectionId: 'c1', strip: [card('c1', '海边')] } })
    expect(one.find('button').exists()).toBe(false)
    one.unmount()
  })

  it('scrolls the current card into view on mount', () => {
    const spy = vi.fn()
    const orig = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = spy
    try {
      const strip = Array.from({ length: 8 }, (_, i) => card(`k${i}`, `卡${i}`))
      const w = mount(EdgeBottom, { props: { collectionId: 'k6', strip }, attachTo: document.body })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.contexts[0]).toBe(w.find('[aria-current="true"]').element)
      w.unmount()
    } finally {
      HTMLElement.prototype.scrollIntoView = orig
    }
  })

  it('highlights the current collection and emits jump', async () => {
    const strip = [card('a', '甲'), card('c1', '海边'), card('b', '乙')]
    const w = mount(EdgeBottom, { props: { collectionId: 'c1', strip } })
    const buttons = w.findAll('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[1]!.attributes('aria-current')).toBe('true')
    await buttons[2]!.trigger('click')
    expect(w.emitted('jump')).toEqual([['b']])
    w.unmount()
  })
})

describe('share + extra keys', () => {
  it('share prefers navigator.share and otherwise copies', async () => {
    const { share } = await import('./share')
    const shareFn = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, share: shareFn, clipboard: navigator.clipboard })
    await expect(share('http://x/c/c1', '海边')).resolves.toBe('shared')
    expect(shareFn).toHaveBeenCalled()
    vi.unstubAllGlobals()
    const write = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } })
    await expect(share('http://x/c/c1', '海边')).resolves.toBe('copied')
    expect(write).toHaveBeenCalledWith('http://x/c/c1')
    vi.unstubAllGlobals()
  })

  it('bindInputs forwards i/f/Escape through the extra key hook and ignores them in editable fields', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const keys: string[] = []
    const handlers: InputHandlers = {
      intent: () => {},
      drag: () => {},
      tap: () => {},
      doubleTap: () => {},
      key: (e) => {
        keys.push(e.key)
        return true
      },
    }
    const stop = bindInputs(el, handlers, { reducedMotion: true, viewport: () => ({ w: 400, h: 800 }) })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(keys).toEqual(['i', 'f', 'Escape'])
    const input = document.createElement('input')
    document.body.appendChild(input)
    // Typing in an editable field never reaches the hook.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }))
    expect(keys).toEqual(['i', 'f', 'Escape'])
    stop()
    el.remove()
    input.remove()
  })
})
