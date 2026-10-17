// Remembers the last collection viewed from each wall so the wall can scroll
// back to it. Storage failures (private mode, blocked site data) are silent.

const key = (wall: string) => `markr:lastViewed:${wall}`

export function remember(wall: string, id: string): void {
  try {
    sessionStorage.setItem(key(wall), id)
  } catch {
    // ignore
  }
}

export function recall(wall: string): string | null {
  try {
    return sessionStorage.getItem(key(wall))
  } catch {
    return null
  }
}

export function forget(wall: string): void {
  try {
    sessionStorage.removeItem(key(wall))
  } catch {
    // ignore
  }
}
