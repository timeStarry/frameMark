import '../styles/photo-transition.css'
import { isPublicPath, plainNavigation } from './publicBrowse.js'

export const PHOTO_TRANSITION_TIMEOUT = 750
const transitionName = 'markr-photo'
const owners = new WeakMap()
let sequence = 0
let intent = null
let intentTimer

function clearIntent() {
  intent = null
  clearTimeout(intentTimer)
}

/** Capture intent before RouterLink handles the click; native navigation stays native. */
export function preparePhotoNavigation(event, sourceRoot) {
  const link = event?.currentTarget
  if (!plainNavigation(event) || !link || link.hasAttribute?.('download') || (link.target && link.target !== '_self')) return
  let destination
  try {
    destination = new URL(link.href, window.location.href)
    if (destination.origin !== window.location.origin || !isPublicPath(destination.pathname)) return
  } catch { return }
  const image = sourceRoot?.querySelector?.('img[data-photo-id]')
  clearIntent()
  if (!image) return
  intent = { source: image, to: destination.pathname + destination.search + destination.hash }
  intentTimer = setTimeout(clearIntent, 1000)
}

function permitsMotion() {
  return typeof document !== 'undefined'
    && typeof document.startViewTransition === 'function'
    && document.visibilityState === 'visible'
    && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    && globalThis.navigator?.connection?.saveData !== true
}

function visible(image) {
  if (!image?.isConnected || !image.dataset.photoId) return false
  const rect = image.getBoundingClientRect()
  const style = window.getComputedStyle(image)
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
    && rect.top < window.innerHeight && rect.left < window.innerWidth
    && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0
}

function imagesIn(root, id) {
  return [...(root?.querySelectorAll('img[data-photo-id]') || [])]
    .filter(image => image.dataset.photoId === id)
}

function currentViewerImage(root) {
  return root?.querySelector('.work-viewer__stage img[data-photo-id]')
}

function sourceFor(root, to, from, hint, requested) {
  if (requested?.to === to.fullPath && root?.contains(requested.source)) return requested.source
  if (hint?.mediaId) {
    const current = currentViewerImage(root)
    // A different selected group image must never turn into the first thumbnail.
    if (current) return current.dataset.photoId === hint.mediaId ? current : null
    return imagesIn(root, hint.mediaId).find(visible) || null
  }
  const matchingLink = [...(root?.querySelectorAll('a[href]') || [])]
    .find(link => link.getAttribute('href') === to.fullPath && link.querySelector('img[data-photo-id]'))
  if (matchingLink) return matchingLink.querySelector('img[data-photo-id]')
  return from.path.startsWith('/work/') ? currentViewerImage(root) : null
}

function targetFor(root, id, hint) {
  if (hint?.focusId) {
    const origin = document.getElementById(hint.focusId)
    // A revoked or changed originating work is not replaced by a coincidental duplicate.
    if (!origin || !root?.contains(origin)) return null
    return [...origin.querySelectorAll('img[data-photo-id]')].find(image => image.dataset.photoId === id) || null
  }
  const current = currentViewerImage(root)
  if (current) return current.dataset.photoId === id ? current : null
  return imagesIn(root, id).find(visible) || null
}

function waitForTarget(root, id, hint, signal) {
  const first = targetFor(root, id, hint)
  if (first) return Promise.resolve(first)
  const pending = () => [...(root?.querySelectorAll('[data-photo-pending]') || [])].some(node => node.dataset.photoPending === id)
  const failed = () => [...(root?.querySelectorAll('[data-photo-failed]') || [])].some(node => node.dataset.photoFailed === id)
  if (!pending() || failed() || typeof MutationObserver === 'undefined') return Promise.resolve(null)
  return new Promise(resolve => {
    const finish = target => { observer.disconnect(); signal.removeEventListener('abort', abort); resolve(target) }
    const abort = () => finish(null)
    const observer = new MutationObserver(() => {
      if (signal.aborted || failed()) return finish(null)
      const target = targetFor(root, id, hint)
      if (target || !pending()) finish(target)
    })
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-photo-pending', 'data-photo-failed', 'data-photo-id'] })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

async function waitForImage(image, signal) {
  if (signal.aborted) throw Error('Photo transition cancelled')
  let abort, loaded, failed
  const cancelled = new Promise((resolve, reject) => {
    abort = () => reject(Error('Photo transition cancelled'))
    signal.addEventListener('abort', abort, { once: true })
  })
  const ready = new Promise((resolve, reject) => {
    failed = () => reject(Error('Photo unavailable'))
    loaded = () => image.naturalWidth ? resolve() : failed()
    image.addEventListener('load', loaded, { once: true })
    image.addEventListener('error', failed, { once: true })
    if (image.complete) loaded()
  })
  try {
    await Promise.race([ready, cancelled])
    if (signal.aborted || !image.isConnected) throw Error('Photo transition cancelled')
    // Race the decoder too: a stuck native decode must not retain the page-ready waiter.
    if (typeof image.decode === 'function') await Promise.race([image.decode(), cancelled])
    if (signal.aborted || !image.isConnected) throw Error('Photo transition cancelled')
  } finally {
    image.removeEventListener('load', loaded)
    image.removeEventListener('error', failed)
    signal.removeEventListener('abort', abort)
  }
}

/** Owns only snapshots and temporary names. API requests and navigation remain independent. */
export function createPhotoTransitionController(router, { getRoot, getReturnHint = () => null } = {}) {
  let active = null
  let disposed = false
  function cleanup(session) {
    clearTimeout(session.timer)
    clearTimeout(session.finishTimer)
    session.targetObserver?.disconnect()
    session.targetObserver = null
    session.preference?.removeEventListener?.('change', session.motionChanged)
    globalThis.navigator?.connection?.removeEventListener?.('change', session.motionChanged)
    document.removeEventListener('visibilitychange', session.motionChanged)
    for (const image of session.images) {
      const owner = owners.get(image)
      if (owner?.session !== session) continue
      owner.name ? image.style.setProperty('view-transition-name', owner.name, owner.priority) : image.style.removeProperty('view-transition-name')
      owner.loading === null ? image.removeAttribute('loading') : image.setAttribute('loading', owner.loading)
      if (image.dataset.photoShared === session.id) delete image.dataset.photoShared
      owners.delete(image)
    }
    session.images.clear()
    if (document.documentElement.dataset.markrPhotoTransition === session.id) delete document.documentElement.dataset.markrPhotoTransition
    if (active === session) active = null
  }
  function nameImage(session, image, eager = false) {
    if (owners.get(image)?.session !== session) {
      owners.set(image, { session, name: image.style.getPropertyValue('view-transition-name'), priority: image.style.getPropertyPriority('view-transition-name'), loading: image.getAttribute('loading') })
      session.images.add(image)
    }
    image.style.setProperty('view-transition-name', transitionName)
    image.dataset.photoShared = session.id
    if (eager) image.loading = 'eager'
  }
  function cancel(session = active) {
    if (!session || session.cancelled) return
    session.cancelled = true
    session.abort.abort()
    session.releaseRoute()
    session.releaseUpdate()
    try { session.transition?.skipTransition() } catch { /* The browser may already have finished. */ }
    cleanup(session)
  }
  const removeBeforeEach = router.beforeEach(() => { cancel(); return true })
  const removeBeforeResolve = router.beforeResolve((to, from) => {
    const requested = intent
    clearIntent()
    if (disposed || !isPublicPath(to.path) || !isPublicPath(from.path) || to.fullPath === from.fullPath || !permitsMotion()) return true
    const hint = getReturnHint(to)
    const source = sourceFor(getRoot(), to, from, hint, requested)
    if (!visible(source) || !source.complete || !source.naturalWidth || source.closest('[data-photo-state="error"]')) return true
    let releaseRoute, releaseUpdate
    const routeGate = new Promise(resolve => { releaseRoute = () => resolve(true) })
    const updateGate = new Promise(resolve => { releaseUpdate = resolve })
    const session = {
      id: String(++sequence), to: to.fullPath, mediaId: source.dataset.photoId, hint,
      images: new Set(), abort: new AbortController(), releaseRoute, releaseUpdate, cancelled: false,
    }
    active = session
    nameImage(session, source)
    document.documentElement.dataset.markrPhotoTransition = session.id
    session.motionChanged = () => { if (!permitsMotion()) cancel(session) }
    session.preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    session.preference?.addEventListener?.('change', session.motionChanged)
    globalThis.navigator?.connection?.addEventListener?.('change', session.motionChanged)
    document.addEventListener('visibilitychange', session.motionChanged)
    session.timer = setTimeout(() => cancel(session), PHOTO_TRANSITION_TIMEOUT)
    try {
      session.transition = document.startViewTransition(() => {
        // The old image has been captured. Only now may Vue Router replace its DOM.
        releaseRoute()
        return updateGate
      })
      Promise.resolve(session.transition.ready).catch(() => cancel(session))
      Promise.resolve(session.transition.finished).catch(() => {}).finally(() => cleanup(session))
    } catch { cancel(session) }
    return routeGate
  })
  const removeAfterEach = router.afterEach((to, from, failure) => {
    if (failure && active?.to === to.fullPath) cancel()
  })
  const removeError = router.onError?.(() => cancel())

  async function pageReady(path, { ok = true } = {}) {
    const session = active
    if (!session || session.to !== path || session.finishing || session.cancelled) return
    session.finishing = true
    if (!ok || !permitsMotion()) return cancel(session)
    const target = await waitForTarget(getRoot(), session.mediaId, session.hint, session.abort.signal)
    if (active !== session || session.cancelled) return
    if (!visible(target) || target.closest('[data-photo-state="error"]')) return cancel(session)
    nameImage(session, target, true)
    if (typeof MutationObserver !== 'undefined') {
      session.targetObserver = new MutationObserver(() => {
        const currentRoot = getRoot()
        const pending = currentRoot?.querySelector('.work-viewer[data-photo-pending]')?.dataset.photoPending
        if (!target.isConnected || !currentRoot?.contains(target) || target.dataset.photoId !== session.mediaId || (pending && pending !== session.mediaId)) cancel(session)
      })
      session.targetObserver.observe(getRoot(), { childList: true, subtree: true, attributes: true, attributeFilter: ['data-photo-id', 'data-photo-pending'] })
    }
    try {
      await waitForImage(target, session.abort.signal)
      if (active !== session || session.cancelled) return
      if (!permitsMotion() || !visible(target) || target.dataset.photoId !== session.mediaId) return cancel(session)
      clearTimeout(session.timer)
      session.releaseUpdate()
      // A defective host implementation must not retain names or detached nodes indefinitely.
      session.finishTimer = setTimeout(() => cancel(session), 1200)
    } catch { cancel(session) }
  }
  function dispose() {
    disposed = true; cancel(); clearIntent()
    removeBeforeEach(); removeBeforeResolve(); removeAfterEach(); removeError?.()
  }
  return { pageReady, cancel, dispose }
}
