import { createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router'

// Route components are lazy so each route gets its own chunk.
export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({
    history,
    routes: [
      { path: '/', name: 'home', component: () => import('./routes/Home.vue') },
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
