import { createRouter, createWebHistory } from 'vue-router'
import Home from '@/views/Platform.vue'
import FrameWatermark from '@/views/FrameWatermark.vue'
import ImageCollage from '@/views/ImageCollage.vue'

const routes = [
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
  routes
})

export default router 