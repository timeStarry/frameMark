import { onBeforeUnmount, watch } from 'vue'

// The browser's same-document available-images list can outlive Image objects,
// even with HTTP no-store. A document-lifetime bit makes all later viewer image
// selections revalidate permission, without retaining IDs, blobs, or pixels.
const speculativeDocuments = new WeakSet()
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id)
const displayURL = id => validId(id) ? `/api/media/${encodeURIComponent(id)}/display` : null

export function createAdjacentPreloader(options = {}) {
  const doc = options.document ?? globalThis.document
  const win = options.window ?? globalThis.window
  const nav = options.navigator ?? globalThis.navigator
  const imageFactory = options.imageFactory || (() => new globalThis.Image())
  const fetcher = options.fetcher || ((...args) => globalThis.fetch(...args))
  const schedule = options.setTimeout || globalThis.setTimeout
  const unschedule = options.clearTimeout || globalThis.clearTimeout
  const timeout = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(options.timeoutMs, 8000)) : 8000
  const entries = new Map(), authorizations = new Set()
  let snapshot = { workId: '', ids: [], index: 0 }, signature = '', disposed = false, decodedCurrent = false
  const connection = nav?.connection
  const eligible = () => !disposed && doc?.visibilityState !== 'hidden' && nav?.onLine !== false && connection?.saveData !== true
  const permissionAvailable = () => !disposed && doc?.visibilityState !== 'hidden' && nav?.onLine !== false
  const wasPrefetched = id => validId(id) && Boolean(doc && speculativeDocuments.has(doc))

  function clearImage(image) {
    image.onload = null; image.onerror = null
    try { image.src = '' } catch { /* Optional hint cleanup must not interrupt navigation. */ }
  }
  function release(entry) {
    unschedule(entry.timer)
    // Native Image has no AbortSignal; replacing src cancels its outstanding
    // image request and releases our decoded-image reference.
    clearImage(entry.image)
    entries.delete(entry.id)
  }
  function clearImages() { for (const entry of [...entries.values()]) release(entry) }
  function conditionsChanged() {
    if (!eligible()) { decodedCurrent = false; clearImages() }
    if (!permissionAvailable()) for (const cancel of [...authorizations]) cancel()
  }
  function update(value) {
    if (disposed) return
    const ids = Array.isArray(value?.ids) ? value.ids.map(id => typeof id === 'string' ? id : '') : []
    const index = Math.max(0, Math.min(Number.isInteger(value?.index) ? value.index : 0, Math.max(0, ids.length - 1)))
    const next = { workId: typeof value?.workId === 'string' ? value.workId : '', ids, index }
    const nextSignature = JSON.stringify(next)
    if (nextSignature === signature) return
    signature = nextSignature; snapshot = next; decodedCurrent = false
    clearImages()
    for (const cancel of [...authorizations]) cancel()
  }
  function decoded(id) {
    if (!eligible() || id !== snapshot.ids[snapshot.index] || !snapshot.workId || snapshot.ids.length < 2) return
    decodedCurrent = true
    const { ids, index } = snapshot
    const adjacent = [...new Set([ids[(index - 1 + ids.length) % ids.length], ids[(index + 1) % ids.length]])]
      .filter(candidate => candidate !== id && displayURL(candidate))
    for (const candidate of adjacent) {
      if (!decodedCurrent || !eligible() || entries.has(candidate) || entries.size >= 2) continue
      let image
      try { image = imageFactory() } catch { continue }
      if (!image) continue
      const entry = { id: candidate, image, timer: null, state: 'loading' }
      entries.set(candidate, entry)
      image.decoding = 'async'; image.fetchPriority = 'low'
      // Do not set crossOrigin: match the displayed PhotoMedia's ordinary
      // same-origin image credentials and available-images cache key.
      image.onload = async () => {
        if (entries.get(candidate) !== entry || entry.state !== 'loading' || !eligible()) return
        try { if (typeof image.decode === 'function') await image.decode() } catch { /* Speculation is optional. */ }
        if (entries.get(candidate) !== entry || entry.state !== 'loading' || !eligible()) return
        unschedule(entry.timer); entry.state = 'decoded'
      }
      image.onerror = () => {
        if (entries.get(candidate) !== entry) return
        // Keep a small failed sentinel so repeated load events do not spin a
        // failing speculative request. It is cleared on a real source change.
        unschedule(entry.timer); clearImage(image); entry.state = 'failed'
      }
      entry.timer = schedule(() => {
        if (entries.get(candidate) !== entry) return
        clearImage(image); entry.state = 'failed'
      }, timeout)
      if (doc && typeof doc === 'object') speculativeDocuments.add(doc)
      try { image.src = displayURL(candidate) } catch { image.onerror?.() }
    }
  }
  async function authorize(id, { signal } = {}) {
    const url = displayURL(id)
    if (!url || !permissionAvailable() || signal?.aborted) return false
    if (!wasPrefetched(id)) return true
    const controller = new AbortController()
    let timer, finish
    const cancelled = new Promise(resolve => { finish = resolve })
    const cancel = () => { controller.abort(); finish(false) }
    authorizations.add(cancel)
    signal?.addEventListener('abort', cancel, { once: true })
    timer = schedule(cancel, timeout)
    try {
      const request = Promise.resolve().then(() => {
        if (controller.signal.aborted || !permissionAvailable()) return false
        return Promise.resolve(fetcher(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', mode: 'same-origin', signal: controller.signal }))
          .then(response => response.status === 200 && !response.redirected && permissionAvailable() && !controller.signal.aborted)
      }).catch(() => false)
      return await Promise.race([request, cancelled])
    } finally {
      unschedule(timer); signal?.removeEventListener('abort', cancel); authorizations.delete(cancel)
    }
  }
  function dispose() {
    if (disposed) return
    disposed = true; decodedCurrent = false; clearImages()
    for (const cancel of [...authorizations]) cancel()
    doc?.removeEventListener?.('visibilitychange', conditionsChanged)
    win?.removeEventListener?.('offline', conditionsChanged)
    win?.removeEventListener?.('online', conditionsChanged)
    connection?.removeEventListener?.('change', conditionsChanged)
  }
  doc?.addEventListener?.('visibilitychange', conditionsChanged)
  win?.addEventListener?.('offline', conditionsChanged)
  win?.addEventListener?.('online', conditionsChanged)
  connection?.addEventListener?.('change', conditionsChanged)
  return { update, decoded, wasPrefetched, authorize, dispose }
}

export function useAdjacentPreload(getSnapshot) {
  const preloader = createAdjacentPreloader()
  const stop = watch(getSnapshot, value => preloader.update(value), { immediate: true, flush: 'sync' })
  onBeforeUnmount(() => { stop(); preloader.dispose() })
  return preloader
}
