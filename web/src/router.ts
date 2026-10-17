import { createRouter, createWebHistory, type RouteLocationNormalized, type Router, type RouterHistory } from 'vue-router'

/**
 * Where a navigation leaves the window scroll: Back/Forward returns to the
 * saved offset; the viewer owns its own scroll (a fixed 100dvh stage) and
 * query-only changes must not jump; any other navigation starts at the top.
 *
 * scrollBehavior applies this itself, synchronously, and returns false. A
 * returned position would be applied by vue-router two microtasks after the
 * render flush, which is after a cached wall's restoreFocus (one microtask
 * after) and would undo it. Scrolling inside the callback keeps the order:
 * router scroll first, then the wall's restore.
 */
export function scrollTarget(
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
  saved: { left?: number; top: number } | null,
): { left?: number; top: number } | false {
  if (saved) return saved
  if (to.name === 'collection' || to.path === from.path) return false
  return { top: 0 }
}

// Route components are lazy so each route gets its own chunk.
export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({
    history,
    // The router scrolls before a wall's restoreFocus (see scrollTarget).
    scrollBehavior(to, from, saved) {
      const p = scrollTarget(to, from, saved)
      if (p) window.scrollTo({ left: p.left ?? 0, top: p.top })
      return false
    },
    routes: [
      { path: '/', name: 'square', component: () => import('./routes/SquareRoute.vue') },
      { path: '/u/:id', name: 'user', component: () => import('./routes/UserRoute.vue'), props: true },
      { path: '/a/:id', name: 'album', component: () => import('./routes/AlbumRoute.vue'), props: true },
      { path: '/tools', name: 'tools', component: () => import('./routes/Placeholder.vue') },
      { path: '/me', name: 'me', component: () => import('./routes/Placeholder.vue') },
      {
        path: '/c/:id',
        name: 'collection',
        component: () => import('./routes/CollectionRoute.vue'),
        props: true,
      },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./routes/NotFound.vue') },
    ],
  })
}
