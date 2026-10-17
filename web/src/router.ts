import { createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router'

// Route components are lazy so each route gets its own chunk.
export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({
    history,
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
