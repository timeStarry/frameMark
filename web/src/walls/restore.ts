// restore.ts — brings the last-viewed card back into view and focus (SP2 §6.4).
import { forget, recall } from '../viewer/lastViewed'

export function restoreFocus(root: HTMLElement, wall: string): boolean {
  const id = recall(wall)
  if (!id) return false
  forget(wall)
  const el = Array.from(root.querySelectorAll<HTMLElement>('[data-card-id]')).find((e) => e.dataset.cardId === id)
  if (!el) return false
  el.scrollIntoView({ block: 'center' })
  el.focus({ preventScroll: true })
  return true
}
