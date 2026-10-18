// guard.ts — the /me access rule (spec §1). Anonymous visitors to /me/* go to
// /login?next=…; next is only ever honoured for in-site /me paths.
import type { RouteLocationNormalized, RouteLocationRaw, Router } from 'vue-router'
import { refresh, session } from '../api/session'

const FALLBACK = '/me'

/** `v` if it is an in-site /me path with no `//` or `\`; otherwise `/me`. */
export function safeNext(v: unknown): string {
  if (typeof v !== 'string') return FALLBACK
  if (!/^\/me(?:[/?#]|$)/.test(v)) return FALLBACK
  if (v.includes('//') || v.includes('\\')) return FALLBACK
  return v
}

/** Loads the session once if it has not loaded yet. A failure leaves the user null. */
async function ensureSession(): Promise<void> {
  if (session.ready) return
  try {
    await refresh()
  } catch {
    // refresh() does not throw; on a network error session.user stays null.
  }
}

/** The access rule for one navigation; `true` lets it through. */
export async function guardNavigation(to: RouteLocationNormalized): Promise<true | RouteLocationRaw> {
  const needsUser = to.matched.some((m) => m.meta.requiresUser === true)
  if (!needsUser && to.name !== 'login') return true
  await ensureSession()
  if (needsUser && !session.user) return { name: 'login', query: { next: to.fullPath } }
  if (to.name === 'login' && session.user) return safeNext(to.query.next)
  return true
}

export function installGuard(router: Router): void {
  router.beforeEach(guardNavigation)
}
