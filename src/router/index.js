import { createRouter, createWebHistory } from 'vue-router'
import Home from '@/views/Platform.vue'
import Toolbox from '@/views/Toolbox.vue'
import Login from '@/views/Login.vue'
import { requireStudioSession } from '../auth/session.mjs'

const routes = [
  { path: '/tools', name: 'Toolbox', component: Toolbox },
  { path: '/login', name: 'Login', component: Login },
  ...['/studio', '/work/:id', '/collection/:id', '/profile/:owner'].map(path => ({path, component: Home})),
  {
    path: '/',
    name: 'Home',
    component: Home
  },
  {
    path: '/frame-watermark',
    name: 'FrameWatermark',
    component: () => import('@/tools/watermark/WatermarkTool.vue')
  },
  {
    path: '/image-collage',
    name: 'ImageCollage',
    component: () => import('@/tools/collage/CollageTool.vue')
  },
  { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('@/views/NotFound.vue') }
]

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to, from, savedPosition) {
    // Public pages restore position after permission-checked content has rendered.
    if (to.path === '/' || /^\/(work|collection|profile)\//.test(to.path)) return false
    return savedPosition || { top: 0 }
  },
  routes
})

router.beforeEach(to => requireStudioSession(to))

export default router 