// backup.ts — a local copy of unsaved desk edits (spec §4.5). Lives in this
// browser only; every storage failure is silent. Cleared when the identity
// changes so one person's drafts never surface for another.
import { onIdentityChange } from '../api/session'

export interface Backup<F = unknown, R = unknown> {
  /** The server's updatedAt the edits were based on. */
  baseUpdatedAt: number
  savedAt: number
  fields: F
  frames: R
}

const PREFIX = 'markr:desk:'

function key(id: string): string {
  return PREFIX + id
}

export function saveBackup<F, R>(id: string, b: Backup<F, R>): void {
  try {
    localStorage.setItem(key(id), JSON.stringify(b))
  } catch {
    // Quota or blocked storage: the backup is best effort.
  }
}

function isBackup(v: unknown): v is Backup {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.baseUpdatedAt === 'number' &&
    Number.isFinite(o.baseUpdatedAt) &&
    typeof o.savedAt === 'number' &&
    Number.isFinite(o.savedAt) &&
    o.fields !== undefined &&
    o.frames !== undefined
  )
}

/** Returns the stored backup, or null; drops anything unreadable. */
export function loadBackup<F = unknown, R = unknown>(id: string): Backup<F, R> | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(key(id))
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (isBackup(v)) return v as Backup<F, R>
  } catch {
    // fall through to removal
  }
  clearBackup(id)
  return null
}

export function clearBackup(id: string): void {
  try {
    localStorage.removeItem(key(id))
  } catch {
    // ignore
  }
}

/** Removes every markr:desk:* key and nothing else. */
export function clearAllBackups(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX)) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
  } catch {
    // ignore
  }
}

onIdentityChange(clearAllBackups)
