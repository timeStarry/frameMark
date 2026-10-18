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
  const router = createRouter({
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
      { path: '/login', name: 'login', component: () => import('./me/LoginRoute.vue') },
      {
        path: '/me',
        component: () => import('./me/MeLayout.vue'),
        meta: { requiresUser: true },
        children: [
          { path: '', name: 'archive', component: () => import('./me/ArchiveRoute.vue'), meta: { requiresUser: true, title: '归档' } },
          { path: 'collections', name: 'me-collections', component: () => import('./me/CollectionsRoute.vue'), meta: { requiresUser: true, title: '合集' } },
          { path: 'settings', name: 'me-settings', component: () => import('./me/SettingsRoute.vue'), meta: { requiresUser: true, title: '偏好' } },
        ],
      },
      {
        path: '/c/:id',
        name: 'collection',
        component: () => import('./routes/CollectionRoute.vue'),
        props: true,
      },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./routes/NotFound.vue') },
    ],
  })
  // The /me guard (me/guard.ts) loads only when a navigation touches /me or
  // /login, so the wall and viewer entry never statically imports src/me.
  router.beforeEach(async (to) => {
    if (to.name !== 'login' && !to.matched.some((m) => m.meta.requiresUser === true)) return true
    const { guardNavigation } = await import('./me/guard')
    return guardNavigation(to)
  })
  return router
}
