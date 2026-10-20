// Shared wall-card helpers: opening a collection from a list or wall, and the
// owner-only status label (SP4a spec §7).
import type { Router } from 'vue-router'
import type { Card } from '../api/types'

/**
 * Opens /c/{id}?wall=… with the wall push state. Modified, non-left or
 * already-handled clicks are left to the browser so the real href still works.
 */
export function openCollection(router: Router, id: string, wall: string, event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  void router.push({
    path: `/c/${encodeURIComponent(id)}`,
    query: { wall },
    state: { fromWall: true, viewerDepth: 0 },
  })
}

/**
 * Wall badge for the owner: 草稿, 仅链接 or 私密. Public published cards and
 * cards without the owner-only fields (a visitor's view) get none.
 */
export function cardBadge(card: Pick<Card, 'status' | 'visibility'>): string | null {
  if (card.status === 'draft') return '草稿'
  if (card.visibility === 'unlisted') return '仅链接'
  if (card.visibility === 'private') return '私密'
  return null
}

/** List label: the wall badge, or 公开 for a published public collection. */
export function cardStatus(card: Pick<Card, 'status' | 'visibility'>): string | null {
  return cardBadge(card) ?? (card.status === 'published' && card.visibility === 'public' ? '公开' : null)
}
