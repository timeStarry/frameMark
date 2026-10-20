// wallRoute.ts — the route a wall value lives at (spec §7). Bare `user` is legacy → owner's page.
export function wallRoute(wall: string | null, ownerId: string): string {
  if (wall === 'square') return '/'
  if (wall?.startsWith('album:') && wall.length > 6) return `/a/${encodeURIComponent(wall.slice(6))}`
  if (wall?.startsWith('user:') && wall.length > 5) return `/u/${encodeURIComponent(wall.slice(5))}`
  return `/u/${encodeURIComponent(ownerId)}`
}
