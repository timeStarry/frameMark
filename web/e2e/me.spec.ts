// Acceptance for the author workspace (SP4a spec §11, task-9 addendum): login,
// archive, uploads, delete, filters, settings, owner badges and layout. Every
// request is served by mockAccount() in e2e/mock.ts.
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  ARCHIVE_YEARS,
  CSRF_MESSAGE,
  EMAIL,
  fixtureFile,
  ME,
  mockAccount,
  PASSWORD,
  REGISTERED_MESSAGE,
  S3_ORIGIN,
  VERIFY_TOKEN,
  type AccountMock,
} from './mock'

/** Safari only moves focus to links and buttons with Option+Tab by default. */
const tabKey = (browserName: string) => (browserName === 'webkit' ? 'Alt+Tab' : 'Tab')

const tiles = (page: Page) => page.locator('button.tile[data-photo-id]')
const tile = (page: Page, id: string) => page.locator(`button.tile[data-photo-id="${id}"]`)
const archiveHeading = (page: Page) => page.getByRole('heading', { level: 1, name: '归档' })
const siteNav = (page: Page) => page.getByRole('navigation', { name: '站点' })
const meNav = (page: Page) => page.getByRole('navigation', { name: '工作区' })

/** Presses Tab until `target` has focus; fails after `max` presses. */
async function tabTo(page: Page, browserName: string, target: Locator, max = 80) {
  const key = tabKey(browserName)
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key)
    if (await target.evaluate((el) => el === document.activeElement)) return
  }
  throw new Error(`Tab did not reach the target in ${max} presses`)
}

async function signIn(page: Page) {
  await page.locator('#login-email').fill(EMAIL)
  await page.locator('#login-password').fill(PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

async function storageDump(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {}
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)!
      out[k] = sessionStorage.getItem(k) ?? ''
    }
    return out
  })
}

const viewerKeys = (dump: Record<string, string>) =>
  Object.keys(dump).filter((k) => k.startsWith('markr:wallCache:') || k.startsWith('markr:lastViewed:'))

function expectNoOriginals(m: AccountMock) {
  expect(m.requests.filter((u) => /\/api\/photos\/[^/]+\/original/.test(u))).toEqual([])
}

test.describe('sign-in and the /me guard', () => {
  test('logged out, /me lands on /login with next=/me; signing in shows the archive', async ({ page }) => {
    const m = await mockAccount(page)
    await page.goto('/me')
    await expect(page).toHaveURL(/\/login\?next=/)
    expect(new URL(page.url()).searchParams.get('next')).toBe('/me')
    await expect(page.getByRole('heading', { level: 1, name: '登录' })).toBeVisible()
    await signIn(page)
    await expect(page).toHaveURL(/\/me$/)
    await expect(archiveHeading(page)).toBeVisible()
    await expect(tiles(page)).toHaveCount(30)
    // Login rotated the token; the write carried the anonymous one.
    const login = m.writes.find((w) => w.path === '/api/auth/login')!
    expect(login.status).toBe(200)
    expect(login.csrf).toBe('csrf-1')
    expect(m.state.csrf).not.toBe('csrf-1')
    expectNoOriginals(m)
  })

  test('a deep /me link comes back after login; a hostile next falls back to /me', async ({ page }) => {
    await mockAccount(page)
    await page.goto('/me/settings')
    await expect(page).toHaveURL(/\/login\?next=/)
    expect(new URL(page.url()).searchParams.get('next')).toBe('/me/settings')
    await signIn(page)
    await expect(page).toHaveURL(/\/me\/settings$/)

    for (const next of ['/me/../u/u1', '//evil.example/me', '/u/u1']) {
      // Each round needs a fresh anonymous session.
      await meNav(page).getByRole('button', { name: '登出' }).click()
      await expect(page).toHaveURL(/127\.0\.0\.1:4173\/$/)
      await page.goto(`/login?next=${encodeURIComponent(next)}`)
      await signIn(page)
      await expect(page).toHaveURL(/127\.0\.0\.1:4173\/me$/)
      await expect(archiveHeading(page)).toBeVisible()
      await page.goto('/me/settings')
    }
  })

  test('a stale CSRF token is refreshed and the write retried once', async ({ page }) => {
    const m = await mockAccount(page, { signedIn: true })
    await page.goto('/me/settings')
    const prefs = page.locator('form').filter({ has: page.getByRole('heading', { name: '上传偏好' }) })
    await prefs.getByRole('switch', { name: '原图下载默认开启' }).check()
    m.staleToken()
    await prefs.getByRole('button', { name: '保存' }).click()
    await expect(prefs.getByRole('status')).toHaveText('已保存')
    const puts = m.writes.filter((w) => w.path === '/api/upload-prefs')
    expect(puts.map((w) => w.status)).toEqual([403, 200])
    expect(puts[0]!.csrf).not.toBe(puts[1]!.csrf)
    expect(puts[1]!.csrf).toBe(m.state.csrf)
    // The refresh happened between the two attempts.
    const i403 = m.order.indexOf('PUT /api/upload-prefs')
    expect(m.order.slice(i403 + 1)).toContain('GET /api/auth/session')
    await expect(page.getByText(CSRF_MESSAGE)).toHaveCount(0)
  })

  test('#verify= shows the set-password form, drops the token from the URL, and lands on /me', async ({ page }) => {
    const m = await mockAccount(page)
    await page.goto(`/login#verify=${VERIFY_TOKEN}`)
    await expect(page.getByRole('heading', { level: 1, name: '设置密码' })).toBeVisible()
    expect(page.url()).not.toContain('verify')
    expect(page.url()).not.toContain(VERIFY_TOKEN)
    const pw = page.getByLabel('新密码')
    await expect(pw).toHaveAttribute('autocomplete', 'new-password')
    // Too short: a local message, no request.
    await pw.fill('short')
    await page.getByRole('button', { name: '设置密码并登录' }).click()
    await expect(page.getByRole('alert')).toHaveText('至少 15 个字符')
    expect(m.writes.some((w) => w.path === '/api/auth/verify')).toBe(false)

    await pw.fill(PASSWORD)
    await page.getByRole('button', { name: '设置密码并登录' }).click()
    await expect(page).toHaveURL(/\/me$/)
    await expect(archiveHeading(page)).toBeVisible()

    const v = m.writes.find((w) => w.path === '/api/auth/verify')!
    expect(v.status).toBe(201)
    expect(v.body).toEqual({ token: VERIFY_TOKEN, password: PASSWORD })
    // The address bar was clean before the verify request went out.
    expect(m.verifyPageURL).not.toBeNull()
    expect(m.verifyPageURL).not.toContain(VERIFY_TOKEN)
    expect(m.verifyPageURL).not.toContain('#')
    const dump = JSON.stringify(await storageDump(page))
    expect(dump).not.toContain(VERIFY_TOKEN)
    expect(dump).not.toContain(PASSWORD)
    const history = await page.evaluate(() => JSON.stringify(history.state))
    expect(history).not.toContain(VERIFY_TOKEN)
    expectNoOriginals(m)
  })

  test('registration closed shows 注册尚未开放。 and no form', async ({ page }) => {
    await mockAccount(page, { registrationOpen: false })
    await page.goto('/login')
    await page.getByRole('tab', { name: '注册' }).click()
    await expect(page.getByText('注册尚未开放。')).toBeVisible()
    await expect(page.locator('#register-email')).toHaveCount(0)
  })

  test('registration open sends the email and shows the server notice', async ({ page }) => {
    const m = await mockAccount(page, { registrationOpen: true })
    await page.goto('/login')
    await page.getByRole('tab', { name: '注册' }).click()
    await page.locator('#register-email').fill(EMAIL)
    await page.getByRole('button', { name: '发送验证邮件' }).click()
    await expect(page.getByRole('status')).toHaveText(REGISTERED_MESSAGE)
    expect(m.writes.find((w) => w.path === '/api/auth/register')!.body).toEqual({ email: EMAIL })
  })
})

test.describe('archive', () => {
  test('upload two files, one already archived: 已在归档中, the other processes and comes first', async ({ page, browserName }) => {
    const m = await mockAccount(page, { signedIn: true })
    await page.goto('/me')
    await expect(tiles(page)).toHaveCount(30)
    await page.locator('input[type=file]').setInputFiles([
      { name: 'dup.jpg', mimeType: 'image/jpeg', buffer: fixtureFile('land') },
      { name: 'new.jpg', mimeType: 'image/jpeg', buffer: fixtureFile('port') },
    ])
    const tray = page.locator('section.tray')
    const dup = tray.locator('li').filter({ hasText: 'dup.jpg' })
    const fresh = tray.locator('li').filter({ hasText: 'new.jpg' })
    await expect(dup).toHaveAttribute('data-state', 'duplicate')
    await expect(dup).toContainText('已在归档中')
    await expect(fresh).toHaveAttribute('data-state', 'processing', { timeout: 10_000 })
    await expect(fresh).toHaveAttribute('data-state', 'done', { timeout: 15_000 })
    await expect(tray.locator('[aria-live="polite"]')).toHaveText('2 张完成')
    await expect(tiles(page).first()).toHaveAttribute('data-photo-id', 'up1')
    await expect(tiles(page).first()).toHaveAccessibleName(/^new，/)
    // The duplicate was not added again.
    await expect(tiles(page)).toHaveCount(31)

    // The direct PUT: the presigned headers, the file, and no cookie or token.
    expect(m.s3).toHaveLength(1)
    const put = m.s3[0]!
    expect(put.method).toBe('PUT')
    expect(put.url).toBe(`${S3_ORIGIN}/mock-s3/up1`)
    expect(put.headers['content-type']).toBe('image/jpeg')
    expect(put.headers['x-amz-checksum-sha256']).toBe('sum-up1')
    expect(put.headers.cookie).toBeUndefined()
    expect(put.headers['x-csrf-token']).toBeUndefined()
    // WebKit's route interception exposes no body for a File PUT (untested there).
    if (browserName === 'chromium') expect(put.bytes).toBe(fixtureFile('port').length)
    // Positive control: same-origin writes do carry the session cookie. WebKit's
    // interception never exposes Cookie, so there the no-cookie check is untested.
    if (browserName === 'chromium') expect(m.apiHeaders.some((h) => (h.cookie ?? '').includes('markr_session='))).toBe(true)
    // Only the new file was completed, and only after its PUT.
    expect(m.writes.filter((w) => w.path.endsWith('/complete')).map((w) => w.path)).toEqual(['/api/uploads/up1/complete'])
    expectNoOriginals(m)
  })

  test('keyboard: open the panel, Esc, delete with the dialog; focus lands on the next tile', async ({ page, browserName }) => {
    const m = await mockAccount(page, { signedIn: true, photos: 6 })
    await page.goto('/me')
    await expect(tiles(page)).toHaveCount(6)
    const t2 = tile(page, 'p2')
    await tabTo(page, browserName, t2)
    await page.keyboard.press('Enter')
    const panel = page.locator('aside.panel')
    await expect(panel).toBeVisible()
    await expect(t2).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(t2).toBeFocused()

    await page.keyboard.press('Enter')
    const del = panel.locator('[data-delete]')
    await tabTo(page, browserName, del)
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: '删除这张照片？' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
    // Esc cancels and focus returns to 删除.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(del).toBeFocused()

    // Reopen (the dialog must open again after a cancel), Tab, Enter confirms.
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
    await page.keyboard.press(tabKey(browserName))
    await expect(dialog.getByRole('button', { name: '删除' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(t2).toHaveCount(0)
    await expect(dialog).toBeHidden()
    await expect(tile(page, 'p3')).toBeFocused()
    await expect(tiles(page)).toHaveCount(5)
    const d = m.writes.filter((w) => w.method === 'DELETE')
    expect(d).toEqual([expect.objectContaining({ path: '/api/photos/p2', status: 204 })])
    expectNoOriginals(m)
  })

  test('filters: each change is a history entry; Back and Forward step through them', async ({ page }) => {
    const m = await mockAccount(page, { signedIn: true })
    await page.goto('/me')
    await expect(tiles(page)).toHaveCount(30)
    const filters = page.getByRole('form', { name: '筛选' })
    const year = filters.getByLabel('年份')
    const camera = filters.getByLabel('机身')
    const in2025 = ARCHIVE_YEARS.filter((y) => y === 2025).length

    // Year A.
    await year.selectOption('2025')
    await expect(page).toHaveURL(/\/me\?year=2025$/)
    await expect(tiles(page)).toHaveCount(in2025)
    await expect(tiles(page).first()).toHaveAttribute('data-photo-id', 'p13')
    expect(m.order).toContain('GET /api/archive')
    expect(m.requests.some((u) => u.includes('/api/archive?year=2025'))).toBe(true)

    // Camera B on top of it. In 2025 (p13..p22) the odd-indexed seeds use GR III.
    await camera.selectOption('GR III')
    await expect(page).toHaveURL(/\/me\?year=2025&camera=GR(%20|\+)III$/)
    await expect(tiles(page)).toHaveCount(in2025 / 2)
    await expect(tiles(page).first()).toHaveAttribute('data-photo-id', 'p14')

    // Back: year A without camera B.
    await page.goBack()
    await expect(page).toHaveURL(/\/me\?year=2025$/)
    await expect(year).toHaveValue('2025')
    await expect(camera).toHaveValue('')
    await expect(tiles(page)).toHaveCount(in2025)
    await expect(tiles(page).first()).toHaveAttribute('data-photo-id', 'p13')

    // Back again: no filters.
    await page.goBack()
    await expect(page).toHaveURL(/\/me$/)
    await expect(year).toHaveValue('')
    await expect(camera).toHaveValue('')
    await expect(tiles(page)).toHaveCount(30)
    await expect(tiles(page).first()).toHaveAttribute('data-photo-id', 'p1')

    // Forward: year A again.
    await page.goForward()
    await expect(page).toHaveURL(/\/me\?year=2025$/)
    await expect(year).toHaveValue('2025')
    await expect(camera).toHaveValue('')
    await expect(tiles(page)).toHaveCount(in2025)
    await expect(tiles(page).first()).toHaveAttribute('data-photo-id', 'p13')

    // A filtered state also survives a round trip through another page.
    await filters.getByLabel('未用于合集').check()
    await expect(page).toHaveURL(/\/me\?year=2025&in_collection=false$/)
    await expect(tiles(page)).toHaveCount(in2025 / 2)
    await meNav(page).getByRole('link', { name: '合集' }).click()
    await expect(page).toHaveURL(/\/me\/collections$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/me\?year=2025&in_collection=false$/)
    await expect(year).toHaveValue('2025')
    await expect(filters.getByLabel('未用于合集')).toBeChecked()
    await expect(tiles(page)).toHaveCount(in2025 / 2)

    await filters.getByRole('button', { name: '清除筛选' }).click()
    await expect(page).toHaveURL(/\/me$/)
    await expect(tiles(page)).toHaveCount(30)
  })

  test('desktop: the open panel starts below the navs, which stay clickable', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockAccount(page, { signedIn: true })
    await page.goto('/me')
    await tile(page, 'p1').click()
    const panel = page.locator('aside.panel')
    await expect(panel).toBeVisible()
    const navBottom = (await meNav(page).boundingBox())!.y + (await meNav(page).boundingBox())!.height
    expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual(navBottom - 0.5)
    // Actionability checks fail if the panel would receive the click instead.
    await meNav(page).getByRole('button', { name: '登出' }).click({ trial: true, timeout: 2000 })
    await meNav(page).getByRole('link', { name: '我的主页' }).click({ trial: true, timeout: 2000 })
    await siteNav(page).getByRole('link', { name: '我的' }).click({ trial: true, timeout: 2000 })
    await siteNav(page).getByRole('link', { name: '工具' }).click({ timeout: 2000 })
    await expect(page).toHaveURL(/\/tools$/)
  })

  test('desktop: after scrolling, the panel sticks to the top and fills the height', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 600 })
    await mockAccount(page, { signedIn: true })
    await page.goto('/me')
    await tile(page, 'p1').click()
    const panel = page.locator('aside.panel')
    await expect(panel).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, 400))
    await expect.poll(async () => (await panel.boundingBox())!.y).toBe(0)
    expect((await panel.boundingBox())!.height).toBeCloseTo(600, 0)
  })
})

test.describe('settings', () => {
  const prefsForm = (page: Page) => page.locator('form').filter({ has: page.getByRole('heading', { name: '上传偏好' }) })
  const profileForm = (page: Page) => page.locator('form').filter({ has: page.getByRole('heading', { name: '主页资料' }) })

  test('save is disabled until a change; leaving asks; save shows 已保存 with the right payload', async ({ page }) => {
    const m = await mockAccount(page, { signedIn: true })
    await page.goto('/me/settings')
    const prefs = prefsForm(page)
    const save = prefs.getByRole('button', { name: '保存' })
    await expect(save).toBeDisabled()
    await expect(profileForm(page).getByRole('button', { name: '保存' })).toBeDisabled()

    await prefs.getByRole('checkbox', { name: 'ISO' }).uncheck()
    await prefs.getByRole('switch', { name: '原图下载默认开启' }).check()
    await prefs.getByLabel('默认许可').selectOption('by-nc')
    await expect(save).toBeEnabled()

    // Dismiss: stay on the page with the edits intact.
    const messages: string[] = []
    page.once('dialog', (d) => {
      messages.push(d.message())
      void d.dismiss()
    })
    await meNav(page).getByRole('link', { name: '归档' }).click()
    await expect.poll(() => messages).toEqual(['有未保存的修改，确定离开？'])
    await expect(page).toHaveURL(/\/me\/settings$/)
    await expect(prefs.getByRole('switch', { name: '原图下载默认开启' })).toBeChecked()

    await save.click()
    await expect(prefs.getByRole('status')).toHaveText('已保存')
    await expect(save).toBeDisabled()
    const put = m.writes.find((w) => w.path === '/api/upload-prefs')!
    expect(put.status).toBe(200)
    expect(put.body).toEqual({
      publicFields: ['camera', 'lens', 'focal_length', 'aperture', 'shutter'],
      histogramPublic: true,
      originalDownload: true,
      watermark: null,
      defaultLicense: 'by-nc',
      defaultAiDeclaration: null,
      locationMode: 'off',
    })

    // Profile save, then accept the leave prompt for a fresh edit.
    const profile = profileForm(page)
    await profile.getByLabel('名字').fill('  阿禾二  ')
    await profile.getByRole('radio', { name: '均匀网格' }).check()
    await profile.getByRole('button', { name: '保存' }).click()
    await expect(profile.getByRole('status')).toHaveText('已保存')
    expect(m.writes.find((w) => w.path === '/api/profile')!.body).toEqual({ name: '  阿禾二  ', bio: '只拍海。', wallLayout: 'grid' })
    await expect(profile.getByLabel('名字')).toHaveValue('阿禾二')

    // Saved: leaving does not ask.
    await meNav(page).getByRole('link', { name: '合集' }).click()
    await expect(page).toHaveURL(/\/me\/collections$/)
    expect(messages).toHaveLength(1)

    await page.goto('/me/settings')
    await prefsForm(page).getByRole('switch', { name: '直方图默认公开' }).uncheck()
    page.once('dialog', (d) => {
      messages.push(d.message())
      void d.accept()
    })
    await meNav(page).getByRole('link', { name: '归档' }).click()
    await expect(page).toHaveURL(/\/me$/)
    expect(messages).toHaveLength(2)
    expect(m.writes.filter((w) => w.path === '/api/upload-prefs')).toHaveLength(1)
  })

  test('Tab reaches every control in DOM order', async ({ page, browserName }) => {
    await mockAccount(page, { signedIn: true })
    await page.goto('/me/settings')
    await expect(prefsForm(page).getByRole('button', { name: '保存' })).toBeVisible()
    await expect(profileForm(page).getByRole('button', { name: '保存' })).toBeVisible()
    // Expected stops: every enabled control in main, one per radio group (the checked one).
    const expected = await page.evaluate(() => {
      const main = document.querySelector('main')!
      const seen = new Set<string>()
      const out: string[] = []
      let n = 0
      for (const el of main.querySelectorAll<HTMLElement>('input, select, textarea, button')) {
        if ((el as HTMLButtonElement).disabled || el.closest('dialog:not([open])')) continue
        if (el instanceof HTMLInputElement && el.type === 'radio') {
          if (!el.checked || seen.has(el.name)) continue
          seen.add(el.name)
        }
        el.dataset.k = String(n++)
        out.push(el.dataset.k)
      }
      return out
    })
    expect(expected.length).toBeGreaterThan(15)
    await page.locator('[data-k="0"]').focus()
    const got = ['0']
    for (let i = 1; i < expected.length; i++) {
      await page.keyboard.press(tabKey(browserName))
      got.push(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.k ?? 'none'))
    }
    expect(got).toEqual(expected)
  })

  test('登出全部设备 asks first, then signs out', async ({ page }) => {
    const m = await mockAccount(page, { signedIn: true })
    await page.goto('/me/settings')
    const open = page.getByRole('button', { name: '登出全部设备' })
    await open.click()
    const dialog = page.getByRole('dialog', { name: '登出全部设备' })
    await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toBeHidden()
    await expect(open).toBeFocused()
    expect(m.writes.some((w) => w.path === '/api/auth/logout-all')).toBe(false)
    await open.click()
    await dialog.getByRole('button', { name: '全部登出' }).click()
    await expect(page).toHaveURL(/127\.0\.0\.1:4173\/$/)
    expect(m.state.user).toBeNull()
    await expect(siteNav(page).getByRole('link', { name: '我的' })).toHaveAttribute('href', '/login')
  })
})

test('collections list shows each status in wall order', async ({ page }) => {
  await mockAccount(page, { signedIn: true })
  await page.goto('/me/collections')
  const rows = page.locator('a.row[data-card-id]')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toHaveAccessibleName('未完成的海，1 张，草稿')
  await expect(rows.nth(1)).toHaveAccessibleName('给朋友看，1 张，仅链接')
  await expect(rows.nth(2)).toHaveAccessibleName('礁石，1 张，公开')
  await expect(rows.nth(0)).toHaveAttribute('href', `/c/d1?wall=user:${ME.id}`)
})

test('owner badges show to the owner only; logout leaves no owner wall cache', async ({ page }) => {
  const m = await mockAccount(page, { signedIn: true })
  await page.goto(`/u/${ME.id}`)
  const badge = (id: string) => page.locator(`a.card[data-card-id="${id}"] .badge`)
  await expect(badge('d1')).toHaveText('草稿')
  await expect(badge('d2')).toHaveText('仅链接')
  await expect(badge('d3')).toHaveCount(0)

  // Leave in-app so the wall saves its snapshot, as a real visit would.
  await siteNav(page).getByRole('link', { name: '我的' }).click()
  await expect(archiveHeading(page)).toBeVisible()
  // Stands in for a viewer visit that was never returned from.
  await page.evaluate((id) => sessionStorage.setItem(`markr:lastViewed:user:${id}`, 'd1'), ME.id)
  const before = await storageDump(page)
  expect(viewerKeys(before)).toEqual(expect.arrayContaining([`markr:wallCache:user:${ME.id}`, `markr:lastViewed:user:${ME.id}`]))
  expect(before[`markr:wallCache:user:${ME.id}`]).toContain('"draft"')

  await meNav(page).getByRole('button', { name: '登出' }).click()
  await expect(page).toHaveURL(/127\.0\.0\.1:4173\/$/)
  expect(viewerKeys(await storageDump(page))).toEqual([])

  await page.goto(`/u/${ME.id}`)
  await expect(page.locator('a.card[data-card-id="d3"]')).toBeVisible()
  await expect(page.locator('a.card[data-card-id]')).toHaveCount(1)
  await expect(page.locator('.badge')).toHaveCount(0)
  await expect(page.getByText('草稿')).toHaveCount(0)
  const after = await storageDump(page)
  expect(JSON.stringify(after)).not.toContain('"draft"')
  expect(m.state.user).toBeNull()
})

test('logout then returning to a private collection shows not-found, not the cached owner view', async ({ page }) => {
  const m = await mockAccount(page, { signedIn: true })
  await page.goto('/me/collections')
  await page.locator('a.row[data-card-id="d1"]').click()
  await expect(page).toHaveURL(/\/c\/d1/)
  const privateFrame = page.locator('img[src*="d1p"], img[srcset*="d1p"]')
  await expect(privateFrame.first()).toBeAttached()
  expect(await page.title()).toContain('未完成的海')

  // Leave in-app (no reload, so the in-memory cache survives). The row was
  // opened with fromWall, so Esc goes back to /me/collections; logout then
  // replaces that entry with /, leaving /c/d1 one step forward in history.
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/me\/collections$/)
  await meNav(page).getByRole('button', { name: '登出' }).click()
  await expect(page).toHaveURL(/127\.0\.0\.1:4173\/$/)
  expect(m.state.user).toBeNull()

  const fetched = m.order.length
  await page.goForward()
  await expect(page).toHaveURL(/\/c\/d1/)
  await expect(page.getByText('这组照片不存在或已不再公开')).toBeVisible()
  await expect(privateFrame).toHaveCount(0)
  await expect(page.getByText('未完成的海')).toHaveCount(0)
  // The anonymous viewer really asked the server, and was told 404.
  expect(m.order.slice(fetched)).toContain('GET /api/collections/d1')
})

test('reduced motion: login → archive → settings round trip', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const m = await mockAccount(page)
  await page.goto('/login')
  await signIn(page)
  await expect(archiveHeading(page)).toBeVisible()
  await expect(tiles(page)).toHaveCount(30)
  await meNav(page).getByRole('link', { name: '偏好' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '偏好' })).toBeVisible()
  // An in-app navigation lands focus on the new page's h1, with its own title.
  await expect(page.getByRole('heading', { level: 1, name: '偏好' })).toBeFocused()
  await expect(page).toHaveTitle('偏好 — Markr')
  await expect(meNav(page).getByRole('link', { name: '偏好' })).toHaveAttribute('aria-current', 'page')
  await meNav(page).getByRole('link', { name: '归档' }).click()
  await expect(archiveHeading(page)).toBeVisible()
  await tile(page, 'p1').click()
  await expect(page.locator('aside.panel')).toBeVisible()
  expectNoOriginals(m)
})

test.describe('no horizontal scroll at four widths', () => {
  const PAGES: { path: string; signedIn: boolean; ready: (p: Page) => Locator }[] = [
    { path: '/login', signedIn: false, ready: (p) => p.getByRole('heading', { level: 1, name: '登录' }) },
    { path: '/me', signedIn: true, ready: (p) => tiles(p).first() },
    { path: '/me/collections', signedIn: true, ready: (p) => p.locator('a.row[data-card-id]').first() },
    { path: '/me/settings', signedIn: true, ready: (p) => p.getByRole('button', { name: '登出全部设备' }) },
  ]
  for (const width of [360, 390, 768, 1440]) {
    for (const pg of PAGES) {
      test(`${pg.path} at ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width < 768 ? 780 : 900 })
        await mockAccount(page, { signedIn: pg.signedIn })
        await page.goto(pg.path)
        await expect(pg.ready(page)).toBeVisible()
        if (pg.path === '/me/settings') await expect(page.getByRole('button', { name: '保存' })).toHaveCount(2)
        const sw = await page.evaluate(() => document.documentElement.scrollWidth)
        expect(sw).toBeLessThanOrEqual(width)
        if (pg.path === '/me') {
          // Also with the panel open.
          await tile(page, 'p1').click()
          await expect(page.locator('aside.panel')).toBeVisible()
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        }
        await testInfo.attach(`${testInfo.project.name}-${width}${pg.path.replace(/\//g, '_')}.png`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
      })
    }
  }
})

test.describe('touch @touch', () => {
  test('the archive panel opens as a bottom sheet and closes', async ({ page }) => {
    await mockAccount(page, { signedIn: true, photos: 6 })
    await page.goto('/me')
    await tile(page, 'p2').tap()
    const sheet = page.locator('aside.panel')
    await expect(sheet).toBeVisible()
    const vp = page.viewportSize()!
    const box = (await sheet.boundingBox())!
    expect(box.x).toBe(0)
    expect(box.width).toBeCloseTo(vp.width, 0)
    expect(box.y + box.height).toBeCloseTo(vp.height, 0)
    expect(box.height).toBeLessThanOrEqual(vp.height * 0.75 + 1)
    await sheet.getByRole('button', { name: '关闭' }).tap()
    await expect(sheet).toHaveCount(0)
    await expect(tile(page, 'p2')).toBeFocused()
  })

  test('with the sheet open, the last tile scrolls fully above it', async ({ page }) => {
    await mockAccount(page, { signedIn: true, photos: 12, pageSize: 20 })
    await page.goto('/me')
    await expect(tiles(page)).toHaveCount(12)
    await tile(page, 'p1').tap()
    const sheet = page.locator('aside.panel')
    await expect(sheet).toBeVisible()
    const last = tile(page, 'p12')
    await expect
      .poll(async () => {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        const t = (await last.boundingBox())!
        const s = (await sheet.boundingBox())!
        return s.y - (t.y + t.height)
      })
      .toBeGreaterThanOrEqual(0)
    // The tile under the sheet is reachable by touch.
    await last.tap()
    await expect(last).toHaveAttribute('aria-expanded', 'true')
  })
})
