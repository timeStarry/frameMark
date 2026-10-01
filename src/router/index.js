import { createRouter, createWebHistory } from 'vue-router'
import Home from '@/views/Platform.vue'
import FrameWatermark from '@/views/FrameWatermark.vue'
import ImageCollage from '@/views/ImageCollage.vue'
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
    component: FrameWatermark
  },
  {
    path: '/image-collage',
    name: 'ImageCollage',
    component: ImageCollage
  }
]

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to, from, savedPosition) { return savedPosition || { top: 0 } },
  routes
})

router.beforeEach(to => requireStudioSession(to))

export default router 