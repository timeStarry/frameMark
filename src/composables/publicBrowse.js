// Navigation hints survive component remounts, but content is always requested again.
const positions = new Map()
const limit = 40

export function publicHistoryPosition() {
  const position = globalThis.window?.history?.state?.position
  return Number.isFinite(position) ? position : null
}

export function rememberPublicPosition(path, state = {}) {
  if (!path) return
  positions.set(path, {
    top: Math.max(0, Number(state.top) || 0),
    left: Math.max(0, Number(state.left) || 0),
    focusId: typeof state.focusId === 'string' ? state.focusId : null,
    pages: Math.max(1, Number(state.pages) || 1),
    position: Number.isFinite(state.position) ? state.position : null,
  })
  if (positions.size > limit) positions.delete(positions.keys().next().value)
}

export function publicPositionFor(path, position) {
  const saved = positions.get(path)
  return saved && saved.position === position ? { ...saved } : null
}

export function isPublicPath(path) {
  return path === '/' || /^\/(?:work|collection|profile)\/[^/]+$/.test(path)
}

export function photoFocusId(record) {
  return `photo-${record.kind === 'collection' ? 'collection' : 'work'}-${record.id}`
}

export function plainNavigation(event) {
  return !event || (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
}
