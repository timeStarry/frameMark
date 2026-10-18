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

/** Removes every wall snapshot and last-viewed marker in this tab. */
export function clearViewerCaches(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && CACHE_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k)
    }
    for (const k of doomed) sessionStorage.removeItem(k)
  } catch {
    // Storage blocked: nothing was cached either.
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

/** Records `user` as the tab's identity; clears caches if it changed or `force`. */
function track(user: string | null, force: boolean): void {
  const next = user ?? NULL_MARKER
  if (force || readIdentity() !== next) {
    clearViewerCaches()
    writeIdentity(next)
  }
}

interface SessionBody {
  user: string | null
  csrfToken: string
  registrationOpen: boolean
}

let inflight: Promise<void> | null = null

/** Reloads the session. Concurrent calls share one request. Never throws. */
export function refresh(): Promise<void> {
  inflight ??= (async () => {
    try {
      const r = await getJSON<SessionBody>('/api/auth/session')
      if (r.ok) {
        state.user = r.data.user ?? null
        state.csrfToken = r.data.csrfToken
        state.registrationOpen = r.data.registrationOpen === true
        track(state.user, false)
      }
    } finally {
      state.ready = true
      inflight = null
    }
  })()
  return inflight
}

interface SignedIn {
  user: string
  csrfToken: string
}

/** Adopts a fresh signed-in session; the token stays in memory only. */
async function signIn(p: Promise<WriteResult<SignedIn>>): Promise<WriteResult<{ user: string }>> {
  const r = await p
  if (!r.ok) return r
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
