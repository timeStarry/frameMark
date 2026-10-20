import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { session } from '../api/session'
import type { UserWall } from '../api/types'

const me = vi.hoisted(() => ({ putProfile: vi.fn() }))
const client = vi.hoisted(() => ({ getUser: vi.fn() }))
vi.mock('../api/me', () => me)
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), ...client }))

import ProfileForm from './ProfileForm.vue'

type Writable = { user: string | null; csrfToken: string | null; ready: boolean }
const s = session as Writable

function wall(over: Partial<UserWall['profile']> = {}): UserWall {
  return { profile: { id: 'u1', name: '阿树', bio: '海边', wallLayout: 'salon', ...over }, collections: [], albums: [] }
}

let w: VueWrapper | null = null

async function open() {
  w = mount(ProfileForm, { attachTo: document.body })
  await flushPromises()
  return w
}

const save = () => w!.findAll('button').find((b) => b.text() === '保存')!
const name = () => w!.find('input[name="name"]')
const bio = () => w!.find('textarea')
const lastDirty = () => {
  const ev = w!.emitted('dirty') as boolean[][] | undefined
  return ev ? ev[ev.length - 1]![0] : undefined
}

beforeEach(() => {
  s.user = 'u1'
  s.ready = true
  sessionStorage.clear()
  me.putProfile.mockReset()
  client.getUser.mockReset().mockResolvedValue({ ok: true, data: wall() })
})

afterEach(() => {
  w?.unmount()
  w = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('ProfileForm', () => {
  it('loads the profile of session.user into labelled fields', async () => {
    await open()
    expect(client.getUser).toHaveBeenCalledWith('u1', expect.any(AbortSignal))
    expect(w!.find('form h2').text()).toBe('主页资料')
    const nameId = name().attributes('id')!
    expect(w!.find(`label[for="${nameId}"]`).text()).toContain('名字')
    expect(name().attributes('required')).toBeDefined()
    expect((name().element as HTMLInputElement).value).toBe('阿树')
    expect(w!.find(`label[for="${bio().attributes('id')}"]`).text()).toContain('简介')
    expect((bio().element as HTMLTextAreaElement).value).toBe('海边')
    const layout = w!.findAll('fieldset').find((f) => f.find('legend').text() === '主页布局')!
    expect(layout.findAll('label').map((l) => l.text())).toEqual(['错列', '均匀网格'])
    expect((layout.find('input[value="salon"]').element as HTMLInputElement).checked).toBe(true)
    expect(save().attributes('disabled')).toBeDefined()
  })

  it('saves name, bio and layout, clears the wall cache and resets the baseline', async () => {
    sessionStorage.setItem('markr:wallCache:user:u1', '{}')
    sessionStorage.setItem('markr:wallCache:square', '{}')
    await open()
    await name().setValue('  阿树树 ')
    expect(lastDirty()).toBe(true)
    await w!.find('input[value="grid"]').setValue(true)
    me.putProfile.mockResolvedValue({
      ok: true,
      status: 200,
      data: { userId: 'u1', name: '阿树树', bio: '海边', wallLayout: 'grid', updatedAt: 5 },
    })
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(me.putProfile).toHaveBeenCalledWith({ name: '  阿树树 ', bio: '海边', wallLayout: 'grid' })
    expect(sessionStorage.getItem('markr:wallCache:user:u1')).toBeNull()
    expect(sessionStorage.getItem('markr:wallCache:square')).toBe('{}')
    expect(w!.find('[role="status"]').text()).toBe('已保存')
    expect((name().element as HTMLInputElement).value).toBe('阿树树')
    expect(save().attributes('disabled')).toBeDefined()
    expect(lastDirty()).toBe(false)
  })

  it('still succeeds when sessionStorage throws', async () => {
    await open()
    await name().setValue('新名字')
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    me.putProfile.mockResolvedValue({ ok: true, status: 200, data: undefined })
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(w!.find('[role="status"]').text()).toBe('已保存')
    expect(lastDirty()).toBe(false)
  })

  it('validates name 1–60 and bio ≤ 500 characters before sending', async () => {
    await open()
    await name().setValue('   ')
    await w!.find('form').trigger('submit')
    expect(me.putProfile).not.toHaveBeenCalled()
    expect(w!.find('[role="alert"]').text()).toBe('名字需为 1–60 个字符。')
    await name().setValue('名'.repeat(61))
    await w!.find('form').trigger('submit')
    expect(me.putProfile).not.toHaveBeenCalled()
    await name().setValue('阿树')
    await bio().setValue('字'.repeat(501))
    await w!.find('form').trigger('submit')
    expect(me.putProfile).not.toHaveBeenCalled()
    expect(w!.find('[role="alert"]').text()).toBe('简介不能超过 500 个字符。')
  })

  it('shows the server message on failure', async () => {
    await open()
    await bio().setValue('新简介')
    me.putProfile.mockResolvedValue({ ok: false, status: 400, message: '主页布局无效。' })
    await w!.find('form').trigger('submit')
    await flushPromises()
    expect(w!.find('[role="alert"]').text()).toBe('主页布局无效。')
    expect(lastDirty()).toBe(true)
  })
})
