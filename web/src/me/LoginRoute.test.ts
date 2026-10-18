import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, type Router } from 'vue-router'
import { createAppRouter } from '../router'
import { session } from '../api/session'
import LoginRoute from './LoginRoute.vue'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Writable = { user: string | null; csrfToken: string | null; ready: boolean; registrationOpen: boolean }
const s = session as Writable
const TOKEN = 'secret-token-abc'
const LONG = 'correct horse battery staple'

let router: Router
let w: VueWrapper | null = null

async function open(path = '/login') {
  await router.push(path)
  await router.isReady()
  w = mount(LoginRoute, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return w
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  s.user = null
  s.csrfToken = 't0'
  s.ready = true
  s.registrationOpen = true
  router = createAppRouter(createMemoryHistory())
  history.replaceState(null, '', '/login')
})

afterEach(() => {
  w?.unmount()
  w = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  history.replaceState(null, '', '/')
})

describe('LoginRoute tabs', () => {
  it('starts on 登录 with an ARIA tablist and labelled main', async () => {
    await open()
    const tabs = w!.findAll('[role="tab"]')
    expect(w!.find('[role="tablist"]').exists()).toBe(true)
    expect(tabs.map((t) => t.text())).toEqual(['登录', '注册'])
    expect(tabs[0]!.attributes('aria-selected')).toBe('true')
    expect(tabs[1]!.attributes('aria-selected')).toBe('false')
    const main = w!.find('main')
    const h1 = w!.find('h1')
    expect(h1.text()).toBe('登录')
    expect(main.attributes('aria-labelledby')).toBe(h1.attributes('id'))
    const panel = w!.find('[role="tabpanel"]')
    expect(panel.attributes('aria-labelledby')).toBe(tabs[0]!.attributes('id'))
  })

  it('switches tabs with the arrow keys and moves focus', async () => {
    await open()
    await w!.findAll('[role="tab"]')[0]!.trigger('keydown', { key: 'ArrowRight' })
    const tabs = w!.findAll('[role="tab"]')
    expect(tabs[1]!.attributes('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[1]!.element)
    expect(w!.find('h1').text()).toBe('注册')
    await tabs[1]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(w!.find('h1').text()).toBe('登录')
  })

  it('gives every input a visible label and the right autocomplete', async () => {
    await open()
    const email = w!.find('input[type="email"]')
    const pw = w!.find('input[type="password"]')
    expect(w!.find(`label[for="${email.attributes('id')}"]`).text()).toBe('邮箱')
    expect(w!.find(`label[for="${pw.attributes('id')}"]`).text()).toBe('密码')
    expect(pw.attributes('autocomplete')).toBe('current-password')
  })

  it('toggles password visibility with aria-pressed', async () => {
    await open()
    const toggle = w!.find('button[aria-pressed]')
    expect(toggle.attributes('aria-pressed')).toBe('false')
    expect(toggle.text()).toBe('显示')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-pressed')).toBe('true')
    expect(toggle.text()).toBe('隐藏')
    expect(w!.find('#login-password').attributes('type')).toBe('text')
  })
})

describe('login', () => {
  it('shows the server error with role=alert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: '邮箱或密码不正确。' }, 401)))
    await open()
    await w!.find('input[type="email"]').setValue('a@example.com')
    await w!.find('#login-password').setValue('whatever')
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(w!.find('[role="alert"]').text()).toBe('邮箱或密码不正确。')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('goes to a safe next on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ user: 'u1', csrfToken: 't1' })))
    await open('/login?next=/me/settings')
    await w!.find('input[type="email"]').setValue('a@example.com')
    await w!.find('#login-password').setValue('whatever')
    await w!.find('form').trigger('submit')
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/me/settings'))
  })

  it('ignores an unsafe next', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ user: 'u1', csrfToken: 't1' })))
    await open('/login?next=https://evil.com')
    await w!.find('input[type="email"]').setValue('a@example.com')
    await w!.find('#login-password').setValue('whatever')
    await w!.find('form').trigger('submit')
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/me'))
  })
})

describe('register', () => {
  it('shows the server message on success', async () => {
    const fn = vi.fn(async () =>
      json({ message: '如果该邮箱可以注册，验证邮件已发送。请在 30 分钟内打开链接并设置密码。' }, 202),
    )
    vi.stubGlobal('fetch', fn)
    await open()
    await w!.findAll('[role="tab"]')[1]!.trigger('click')
    await w!.find('input[type="email"]').setValue('a@example.com')
    expect(w!.find('input[type="password"]').exists()).toBe(false)
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(w!.find('[role="status"]').text()).toBe('如果该邮箱可以注册，验证邮件已发送。请在 30 分钟内打开链接并设置密码。')
    expect(fn).toHaveBeenCalledWith('/api/auth/register', expect.anything())
  })

  it('shows the closed message and no form when registration is closed', async () => {
    s.registrationOpen = false
    await open()
    await w!.findAll('[role="tab"]')[1]!.trigger('click')
    const panel = w!.find('[role="tabpanel"]')
    expect(panel.text()).toBe('注册尚未开放。')
    expect(panel.find('form').exists()).toBe(false)
  })
})

describe('verify', () => {
  it('removes the token from the URL before any request and never stores it', async () => {
    history.replaceState(null, '', `/login?next=/me/collections#verify=${TOKEN}`)
    const order: string[] = []
    const replace = vi.spyOn(history, 'replaceState').mockImplementation(function (this: History, ...a) {
      order.push('replaceState')
      return History.prototype.replaceState.apply(this, a as Parameters<History['replaceState']>)
    })
    const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => {
      order.push(`fetch ${url}`)
      return json({ user: 'u1', csrfToken: 't1' })
    })
    vi.stubGlobal('fetch', fetchFn)
    const setLocal = vi.spyOn(Storage.prototype, 'setItem')
    const log = vi.spyOn(console, 'log')

    await open('/login?next=/me/collections')
    expect(replace).toHaveBeenCalledWith(null, '', '/login?next=/me/collections')
    expect(location.hash).toBe('')
    expect(w!.find('h1').text()).toBe('设置密码')
    expect(w!.find('[role="tablist"]').exists()).toBe(false)

    const pw = w!.find('#verify-password')
    expect(pw.attributes('autocomplete')).toBe('new-password')
    expect(w!.text()).toContain('至少 15 个字符')
    await pw.setValue(LONG)
    await w!.find('form').trigger('submit')
    await flushPromises()

    expect(order[0]).toBe('replaceState')
    expect(order).toContain('fetch /api/auth/verify')
    const init = fetchFn.mock.calls.find((c) => c[0] === '/api/auth/verify')![1]!
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN, password: LONG })
    for (const c of setLocal.mock.calls) expect(String(c[1])).not.toContain(TOKEN)
    for (const c of log.mock.calls) expect(c.join(' ')).not.toContain(TOKEN)
    expect(location.href).not.toContain(TOKEN)
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/me/collections'))
  })

  it('rejects a short password locally', async () => {
    history.replaceState(null, '', `/login#verify=${TOKEN}`)
    const fetchFn = vi.fn(async () => json({}))
    vi.stubGlobal('fetch', fetchFn)
    await open()
    await w!.find('#verify-password').setValue('short')
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(w!.find('[role="alert"]').text()).toBe('至少 15 个字符')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('shows the server error when verify fails', async () => {
    history.replaceState(null, '', `/login#verify=${TOKEN}`)
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: '链接无效或已过期。' }, 400)))
    await open()
    await w!.find('#verify-password').setValue(LONG)
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(w!.find('[role="alert"]').text()).toBe('链接无效或已过期。')
  })
})
