// wallCache.ts — per-tab wall snapshot so a return renders instantly (spec §6).
export const TTL_MS = 30 * 60 * 1000
const key = (wall: string) => `markr:wallCache:${wall}`

export function save<T>(wall: string, data: T, now = Date.now()): void {
  try {
    sessionStorage.setItem(key(wall), JSON.stringify({ savedAt: now, data }))
  } catch {
    // ignore
  }
}

export function load<T>(wall: string, now = Date.now()): T | null {
  try {
    const raw = sessionStorage.getItem(key(wall))
    if (!raw) return null
    const v = JSON.parse(raw) as { savedAt?: unknown; data?: T }
    if (typeof v.savedAt !== 'number' || now - v.savedAt > TTL_MS || v.data === undefined) {
      sessionStorage.removeItem(key(wall))
      return null
    }
    return v.data
  } catch {
    return null
  }
}
