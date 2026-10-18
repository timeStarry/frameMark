import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import type { UploadPrefs, UserWall } from '../api/types'

const me = vi.hoisted(() => ({ getPrefs: vi.fn(), putPrefs: vi.fn(), putProfile: vi.fn() }))
const client = vi.hoisted(() => ({ getUser: vi.fn() }))
const auth = vi.hoisted(() => ({ logout: vi.fn(), logoutAll: vi.fn() }))
vi.mock('../api/me', () => me)
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), ...client }))
vi.mock('../api/session', async (orig) => ({ ...(await orig<typeof import('../api/session')>()), ...auth }))

import { session } from '../api/session'
import SettingsRoute from './SettingsRoute.vue'

type Writable = { user: string | null; ready: boolean }
const s = session as Writable

const PREFS: UploadPrefs = {
  publicFields: ['camera'],
  histogramPublic: true,
  originalDownload: false,
  watermark: null,
  defaultLicense: null,
  defaultAiDeclaration: null,
  locationMode: 'off',
  updatedAt: null,
}
const WALL: UserWall = {
  profile: { id: 'u1', name: '阿树', bio: '', wallLayout: 'salon' },
  collections: [],
  albums: [],
}

let router: Router
let w: VueWrapper | null = null

async function open() {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      { path: '/me/settings', component: SettingsRoute },
      { path: '/elsewhere', component: { render: () => null } },
    ],
  })
  await router.push('/me/settings')
  await router.isReady()
  w = mount(defineComponent({ render: () => h(RouterView) }), { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return w
}

const button = (text: string) => w!.findAll('button').find((b) => b.text() === text)!
const unload = () => {
  const e = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(e)
  return e.defaultPrevented
}

beforeEach(() => {
  s.user = 'u1'
  s.ready = true
  me.getPrefs.mockReset().mockResolvedValue({ ok: true, data: PREFS })
  me.putPrefs.mockReset()
  me.putProfile.mockReset()
  client.getUser.mockReset().mockResolvedValue({ ok: true, data: WALL })
  auth.logout.mockReset()
  auth.logoutAll.mockReset()
})

afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SettingsRoute', () => {
  it('labels main with the 偏好 h1 and renders three forms with headings', async () => {
    await open()
    const h1 = w!.find('main h1')
    expect(h1.text()).toBe('偏好')
    expect(w!.find('main').attributes('aria-labelledby')).toBe(h1.attributes('id'))
    expect(w!.findAll('form').map((f) => f.find('h2').text())).toEqual(['上传偏好', '主页资料', '账户'])
  })

  it('guards leaving while a form is dirty', async () => {
    await open()
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    expect(unload()).toBe(false)
    await w!.find('input[value="iso"]').setValue(true)
    expect(unload()).toBe(true)
    await router.push('/elsewhere')
    expect(confirm).toHaveBeenCalledWith('有未保存的修改，确定离开？')
    expect(router.currentRoute.value.fullPath).toBe('/me/settings')
    confirm.mockReturnValue(true)
    await router.push('/elsewhere')
    expect(router.currentRoute.value.fullPath).toBe('/elsewhere')
    expect(unload()).toBe(false)
  })

  it('drops the beforeunload listener once the form is clean again', async () => {
    await open()
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    await w!.find('input[name="name"]').setValue('新名字')
    expect(unload()).toBe(true)
    await w!.find('input[name="name"]').setValue('阿树')
    expect(unload()).toBe(false)
    await router.push('/elsewhere')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('leaves without asking when nothing changed', async () => {
    await open()
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    await router.push('/elsewhere')
    expect(confirm).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/elsewhere')
  })

  it('signs out and goes home', async () => {
    await open()
    auth.logout.mockResolvedValue({ ok: true, status: 200, data: {} })
    await button('登出').trigger('click')
    await flushPromises()
    expect(auth.logout).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.fullPath).toBe('/')
  })

  it('confirms before signing out everywhere, then goes home', async () => {
    await open()
    expect(w!.find('dialog').attributes('open')).toBeUndefined()
    await button('登出全部设备').trigger('click')
    const dialog = w!.find('dialog')
    expect(dialog.attributes('open')).toBeDefined()
    expect(dialog.find('h2').text()).toBe('登出全部设备')
    expect(dialog.text()).toContain('所有设备上的登录都会失效，包括这一台。')
    await dialog.findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    expect(auth.logoutAll).not.toHaveBeenCalled()
    expect(w!.find('dialog').attributes('open')).toBeUndefined()

    auth.logoutAll.mockResolvedValue({ ok: true, status: 200, data: {} })
    await button('登出全部设备').trigger('click')
    await w!.find('dialog').findAll('button').find((b) => b.text() === '全部登出')!.trigger('click')
    await flushPromises()
    expect(auth.logoutAll).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.fullPath).toBe('/')
  })

  it('shows the message when signing out everywhere fails', async () => {
    await open()
    auth.logoutAll.mockResolvedValue({ ok: false, status: 500, message: '登出失败。' })
    await button('登出全部设备').trigger('click')
    await w!.find('dialog').findAll('button').find((b) => b.text() === '全部登出')!.trigger('click')
    await flushPromises()
    expect(w!.find('[role="alert"]').text()).toBe('登出失败。')
    expect(router.currentRoute.value.fullPath).toBe('/me/settings')
  })
})
