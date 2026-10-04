import { onBeforeUnmount, onMounted, unref } from 'vue'

// Presentation memory only: no photograph, identity, or permission responses are cached.
const seen = new Set()
const targets = new Map()
const running = new Map()
let observer

function reducedMotion() {
  return typeof window === 'undefined'
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    || globalThis.navigator?.connection?.saveData === true
    || globalThis.document?.documentElement?.hasAttribute('data-markr-photo-transition')
}

function remember(key) {
  if (!key) return
  seen.add(key)
  if (seen.size > 600) seen.delete(seen.values().next().value)
}

function reveal(element, immediate = false) {
  const settings = targets.get(element)
  if (!settings) return
  targets.delete(element)
  observer?.unobserve(element)
  remember(settings.key)
  if (!immediate && !reducedMotion() && typeof element.animate === 'function') {
    const animation = element.animate([
      { opacity: 0, transform: 'translateY(10px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], {
      duration: settings.append ? 340 : 420,
      delay: Math.min(settings.index * (settings.append ? 24 : 28), settings.append ? 96 : 112),
      easing: 'cubic-bezier(.22,1,.36,1)',
      fill: 'backwards',
    })
    running.set(element, animation)
    animation.finished?.catch(() => {}).finally(() => running.delete(element))
  }
  if (!targets.size) {
    observer?.disconnect()
    observer = undefined
  }
}

/** Optional reveal enhancement. Content is visible without IO, WAAPI, or JavaScript animation. */
export function useReveal(elementRef, options = {}) {
  let element
  let preference
  function stop() {
    if (!element) return
    running.get(element)?.cancel()
    running.delete(element)
    reveal(element, true)
  }
  function focus() { stop() }
  onMounted(() => {
    element = unref(elementRef)
    if (!element) return
    const value = typeof options === 'function' ? options() : options
    const key = value.key
    if (seen.has(key) || reducedMotion() || typeof IntersectionObserver === 'undefined') {
      remember(key)
      return
    }
    if (!observer) observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) reveal(entry.target)
    }, { threshold: 0.08 })
    targets.set(element, { key, index: Math.max(0, value.index || 0), append: value.append === true })
    observer.observe(element)
    element.addEventListener('focusin', focus)
    preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    preference?.addEventListener?.('change', stop)
  })
  onBeforeUnmount(() => {
    stop()
    element?.removeEventListener('focusin', focus)
    preference?.removeEventListener?.('change', stop)
  })
}
