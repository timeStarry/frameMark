import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreFocus } from './restore'

let root: HTMLElement
let scroll: ReturnType<typeof vi.fn>
const original = HTMLElement.prototype.scrollIntoView

beforeEach(() => {
  root = document.createElement('div')
  for (const id of ['c1', 'c2', 'c3']) {
    const a = document.createElement('a')
    a.dataset.cardId = id
    a.href = `/c/${id}`
    root.appendChild(a)
  }
  document.body.appendChild(root)
  scroll = vi.fn()
  HTMLElement.prototype.scrollIntoView = scroll as unknown as typeof original
})

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = original
  root.remove()
  sessionStorage.clear()
})

describe('restoreFocus', () => {
  it('scrolls to and focuses the last-viewed card, then forgets it', () => {
    sessionStorage.setItem('markr:lastViewed:square', 'c2')
    expect(restoreFocus(root, 'square')).toBe(true)
    expect(document.activeElement).toBe(root.querySelector('[data-card-id="c2"]'))
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    expect(sessionStorage.getItem('markr:lastViewed:square')).toBeNull()
  })

  it('returns false and forgets an unknown id', () => {
    sessionStorage.setItem('markr:lastViewed:square', 'nope')
    expect(restoreFocus(root, 'square')).toBe(false)
    expect(sessionStorage.getItem('markr:lastViewed:square')).toBeNull()
    expect(scroll).not.toHaveBeenCalled()
    expect(root.contains(document.activeElement)).toBe(false)
  })

  it('returns false with no key', () => {
    expect(restoreFocus(root, 'square')).toBe(false)
    expect(scroll).not.toHaveBeenCalled()
  })
})
