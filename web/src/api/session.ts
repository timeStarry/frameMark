// session.ts — the reactive auth session (spec §3). Starts anonymous; call
// refresh() at boot. When the identity changes, cached wall data from the
// previous person is cleared so owner-only cards never leak in the tab.
import { reactive } from 'vue'
import { getJSON } from './client'
import { send, type WriteResult } from './write'

export interface SessionState {
  ready: boolean
  user: string | null
  csrfToken: string | null
  registrationOpen: boolean
}

const state = reactive<SessionState>({ ready: false, user: null, csrfToken: null, registrationOpen: false })
export const session: Readonly<SessionState> = state

/** The only key this module stores: a user id, or NULL_MARKER when anonymous. */
const IDENTITY_KEY = 'markr:identity'
const NULL_MARKER = 'null'
const CACHE_PREFIXES = ['markr:wallCache:', 'markr:lastViewed:']

/**
 * Desk backups (markr:desk:*) live in localStorage and hold unpublished text.
 * They are cleared here, in the always-loaded session layer, so a logout or a
 * user switch clears them even in a tab that never loaded the desk chunk.
 */
const BACKUP_PREFIX = 'markr:desk:'

function sweep(store: Storage, match: (k: string) => boolean) {
  try {
    const doomed: string[] = []
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k && match(k)) doomed.push(k)
    }
    for (const k of doomed) store.removeItem(k)
  } catch {
    // Storage blocked: nothing was cached either.
  }
}

/** Removes every wall snapshot, last-viewed marker and desk backup for this browser. */
export function clearViewerCaches(): void {
  try {
    sweep(sessionStorage, (k) => CACHE_PREFIXES.some((p) => k.startsWith(p)))
  } catch {
    // sessionStorage itself unavailable.
  }
  try {
    sweep(localStorage, (k) => k.startsWith(BACKUP_PREFIX))
  } catch {
    // localStorage itself unavailable.
  }
}

function readIdentity(): string | undefined {
  try {
    return sessionStorage.getItem(IDENTITY_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function writeIdentity(v: string): void {
  try {
    sessionStorage.setItem(IDENTITY_KEY, v)
  } catch {
    // ignore
  }
}

const identityListeners = new Set<() => void>()

/**
 * Registers `fn` to run whenever the tab's identity changes (login, verify,
 * logout, or a refresh that finds a different user), at the same point the
 * sessionStorage caches are cleared. In-memory caches holding viewer data
 * register here. Returns an unsubscribe function.
 */
export function onIdentityChange(fn: () => void): () => void {
  identityListeners.add(fn)
  return () => {
    identityListeners.delete(fn)
  }
}

/** Records `user` as the tab's identity; clears caches if it changed or `force`. */
function track(user: string | null, force: boolean): void {
  const next = user ?? NULL_MARKER
  if (force || readIdentity() !== next) {
    clearViewerCaches()
    for (const fn of identityListeners) {
      try {
        fn()
      } catch {
        // One listener failing must not keep the others from clearing.
      }
    }
    writeIdentity(next)
  }
}

interface SessionBody {
  user: string | null
  csrfToken: string
  registrationOpen: boolean
}

/**
 * Bumped by every login, verify and logout. A refresh that started under an
 * older generation drops its response, so it can never overwrite a newer
 * identity or token with stale values.
 */
let generation = 0
let inflight: { gen: number; done: Promise<void> } | null = null

/** Reloads the session. Concurrent calls share one request. Never throws. */
export function refresh(): Promise<void> {
  if (inflight && inflight.gen === generation) return inflight.done
  const gen = generation
  const entry: { gen: number; done: Promise<void> } = { gen, done: Promise.resolve() }
  entry.done = (async () => {
    try {
      const r = await getJSON<SessionBody>('/api/auth/session')
      if (r.ok && gen === generation) {
        state.user = r.data.user ?? null
        state.csrfToken = r.data.csrfToken
        state.registrationOpen = r.data.registrationOpen === true
        track(state.user, false)
      }
    } finally {
      state.ready = true
      if (inflight === entry) inflight = null
    }
  })()
  inflight = entry
  return entry.done
}

interface SignedIn {
  user: string
  csrfToken: string
}

/** Adopts a fresh signed-in session; the token stays in memory only. */
async function signIn(p: Promise<WriteResult<SignedIn>>): Promise<WriteResult<{ user: string }>> {
  const r = await p
  if (!r.ok) return r
  generation++
  state.user = r.data.user
  state.csrfToken = r.data.csrfToken
  state.ready = true
  track(state.user, true)
  return { ok: true, status: r.status, data: { user: r.data.user } }
}

export function login(email: string, password: string): Promise<WriteResult<{ user: string }>> {
  return signIn(send<SignedIn>('POST', '/api/auth/login', { email, password }))
}

export function register(email: string): Promise<WriteResult<unknown>> {
  return send<unknown>('POST', '/api/auth/register', { email })
}

export function verify(token: string, password: string): Promise<WriteResult<{ user: string }>> {
  return signIn(send<SignedIn>('POST', '/api/auth/verify', { token, password }))
}

/** The server drops the session; fetch an anonymous one for the next write. */
async function signOut(url: string): Promise<WriteResult<unknown>> {
  const r = await send<unknown>('POST', url)
  if (!r.ok) return r
  generation++
  state.user = null
  state.csrfToken = null
  track(null, true)
  await refresh()
  return r
}

export function logout(): Promise<WriteResult<unknown>> {
  return signOut('/api/auth/logout')
}

export function logoutAll(): Promise<WriteResult<unknown>> {
  return signOut('/api/auth/logout-all')
}
