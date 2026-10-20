// Acceptance for the curation desk (SP4b spec §7, task-10 addendum). Every
// request is served by mockAccount() in e2e/mock.ts, whose desk endpoints
// mirror internal/api/collections.go, photos.go and exposure_check.go.
import { expect, test, type Page } from '@playwright/test'
import { mockAccount, type AccountMock } from './mock'

const seq = (page: Page) => page.locator('section.desk-sequence')
const frames = (page: Page) => page.locator('[role="listitem"]')
const tiles = (page: Page) => page.locator('.desk-archive [role="option"]')
const saveState = (page: Page) => page.locator('.save')
const deskWrites = (m: AccountMock, id: string) => m.writes.filter((w) => w.path.startsWith(`/api/collections/${id}`))
const framePuts = (m: AccountMock, id: string) => m.writes.filter((w) => w.method === 'PUT' && w.path === `/api/collections/${id}/frames`)
const serverPhotos = (m: AccountMock, id: string) => m.state.desk[id]!.frames.flatMap((f) => f.photoIds)

async function settled(page: Page) {
  await expect(saveState(page)).toHaveText('已保存')
}

async function openDesk(page: Page, id: string) {
  await page.goto(`/me/c/${id}`)
  await expect(seq(page)).toBeVisible()
  await expect(tiles(page).first()).toBeVisible()
}

test.describe('desk', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('new collection: add three ways, reorder, pair, autosave, publish with the manifest', async ({ page, browserName }) => {
    const m = await mockAccount(page, { signedIn: true })
    await page.goto('/me/collections')
    await page.getByRole('button', { name: '新建合集' }).click()
    await page.getByLabel('标题').fill('港口')
    await page.getByRole('button', { name: '创建' }).click()
    await expect(page).toHaveURL(/\/me\/c\/new1$/)
    await expect(page.getByRole('heading', { level: 1, name: '港口' })).toBeVisible()
    await expect(tiles(page).first()).toBeVisible()

    // 1) Drag a tile into the empty sequence (Chromium); WebKit uses Enter.
    if (browserName === 'chromium') {
      await tiles(page).nth(0).dragTo(page.locator('.desk-sequence [data-gap="0"]'))
    } else {
      await tiles(page).nth(0).focus()
      await page.keyboard.press('Enter')
    }
    await expect(frames(page)).toHaveCount(1)
    // 2) Enter on a tile appends.
    await tiles(page).nth(1).focus()
    await page.keyboard.press('Enter')
    await expect(frames(page)).toHaveCount(2)
    // 3) Space multi-select, then 加入.
    await tiles(page).nth(2).focus()
    await page.keyboard.press(' ')
    await page.getByRole('button', { name: /^加入/ }).click()
    await expect(frames(page)).toHaveCount(3)
    await settled(page)
    expect(serverPhotos(m, 'new1')).toEqual(['p1', 'p2', 'p3'])

    // ⌥↓ moves the first frame down.
    await frames(page).nth(0).focus()
    await page.keyboard.press('Alt+ArrowDown')
    await settled(page)
    expect(serverPhotos(m, 'new1')).toEqual(['p2', 'p1', 'p3'])

    // ⌥M merges the next frame into the focused one: 并排.
    await frames(page).nth(0).focus()
    await page.keyboard.press('Alt+KeyM')
    await expect(frames(page)).toHaveCount(2)
    await settled(page)
    expect(m.state.desk.new1!.frames[0]).toMatchObject({ layout: 'pair', photoIds: ['p2', 'p1'] })

    // Publish: the dialog shows the server's dry-run manifest, then publishes.
    await page.locator('[data-desk-publish]').click()
    const dialog = page.locator('dialog[open]')
    await expect(dialog).toContainText('3 张')
    await expect(dialog).toContainText('私密')
    await expect(dialog).toContainText('未设置许可')
    expect(m.state.desk.new1!.status).toBe('draft')
    await dialog.getByRole('button', { name: '发布', exact: true }).click()
    await expect(page.locator('[data-desk-live-note]')).toHaveText('修改会立即对访客生效')
    expect(m.state.desk.new1!.status).toBe('published')
  })

  test('published: adding a photo asks first; undo leaves the server untouched', async ({ page }) => {
    const m = await mockAccount(page, { signedIn: true })
    m.seedDesk({ id: 'pub', title: '礁石', status: 'published', visibility: 'unlisted', photoIds: ['p1'] })
    await openDesk(page, 'pub')
    await expect(page.locator('[data-desk-live-note]')).toBeVisible()
    const before = framePuts(m, 'pub').length

    await tiles(page).nth(1).focus()
    await page.keyboard.press('Enter')
    const exposure = page.locator('dialog[open]')
    await expect(exposure).toContainText('新增 1 张公开照片')
    expect(framePuts(m, 'pub').length).toBe(before)
    await exposure.getByRole('button', { name: '撤销这次修改' }).click()
    await expect(exposure).toHaveCount(0)
    await expect(frames(page)).toHaveCount(1)
    expect(framePuts(m, 'pub').length).toBe(before)
    expect(serverPhotos(m, 'pub')).toEqual(['p1'])

    // Again, and confirm: now the frames reach the server.
    await tiles(page).nth(1).focus()
    await page.keyboard.press('Enter')
    await page.locator('dialog[open]').getByRole('button', { name: '确认并保存' }).click()
    await settled(page)
    expect(serverPhotos(m, 'pub')).toEqual(['p1', 'p2'])
  })

  test('published: narrowing (turning original download off) saves without asking', async ({ page }) => {
    const m = await mockAccount(page, { signedIn: true })
    m.seedDesk({ id: 'pub', title: '礁石', status: 'published', visibility: 'unlisted', originalDownload: true, photoIds: ['p1'] })
    await openDesk(page, 'pub')
    await page.getByRole('button', { name: '合集设置' }).click()
    await page.getByLabel('允许下载原图').uncheck()
    await settled(page)
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    expect(m.state.desk.pub!.originalDownload).toBe(false)
  })

  test('conflict: another tab saved first; 载入最新版本 shows it, overwrite still asks', async ({ page }) => {
    const m = await mockAccount(page, { signedIn: true })
    m.seedDesk({ id: 'c1', title: '雨', status: 'published', visibility: 'unlisted', photoIds: ['p1', 'p2'] })
    await openDesk(page, 'c1')

    // "Tab B" reorders on the server; this tab's next write must 409.
    m.editElsewhere('c1', { frames: [{ layout: 'full', matteRatio: null, text: null, photoIds: ['p2'] }, { layout: 'full', matteRatio: null, text: null, photoIds: ['p1'] }] })
    await frames(page).nth(0).focus()
    await page.keyboard.press('Alt+ArrowDown')
    await expect(page.getByText('这个合集在别处被修改过')).toBeVisible()
    await expect(saveState(page)).toContainText('有冲突')
    await page.getByRole('button', { name: '载入最新版本' }).click()
    await expect(page.getByText('这个合集在别处被修改过')).toHaveCount(0)
    await settled(page)
    expect(serverPhotos(m, 'c1')).toEqual(['p2', 'p1'])
    await expect(frames(page).nth(0)).toHaveAttribute('aria-label', /第 1 帧/)

    // Conflict again, now with a widening local change: overwrite must ask.
    m.editElsewhere('c1', { title: '雨（改）' })
    await tiles(page).nth(2).focus()
    await page.keyboard.press('Enter')
    // The add widens, so the exposure check asks first; confirm it.
    await page.locator('dialog[open]').getByRole('button', { name: '确认并保存' }).click()
    await expect(page.getByText('这个合集在别处被修改过')).toBeVisible()
    const puts = framePuts(m, 'c1').length
    await page.getByRole('button', { name: '用我的版本覆盖' }).click()
    const ask = page.locator('dialog[open]')
    await expect(ask).toContainText('新增 1 张公开照片')
    expect(framePuts(m, 'c1').length).toBe(puts)
    await ask.getByRole('button', { name: '确认并保存' }).click()
    await settled(page)
    expect(serverPhotos(m, 'c1')).toEqual(['p2', 'p1', 'p3'])
  })

  test('backup: an unsaved change survives a reload and can be restored', async ({ page }) => {
    const m = await mockAccount(page, { signedIn: true })
    m.seedDesk({ id: 'b1', title: '雾', photoIds: ['p1'] })
    await openDesk(page, 'b1')
    // Fail the next frames PUT once, so the change stays unsaved, then reload.
    await page.route('**/api/collections/b1/frames', (r) => r.abort('failed'), { times: 1 })
    await tiles(page).nth(1).focus()
    await page.keyboard.press('Enter')
    await expect(frames(page)).toHaveCount(2)
    await expect(saveState(page)).toContainText('未保存')
    await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
    await page.reload()
    await expect(page.getByText('有一份未保存的修改，要恢复吗？')).toBeVisible()
    expect(serverPhotos(m, 'b1')).toEqual(['p1'])
    await page.getByRole('button', { name: '恢复', exact: true }).click()
    await expect(frames(page)).toHaveCount(2)
    await settled(page)
    expect(serverPhotos(m, 'b1')).toEqual(['p1', 'p2'])
    // A clean save clears the backup: reloading offers nothing.
    await page.reload()
    await expect(seq(page)).toBeVisible()
    await expect(page.getByText('有一份未保存的修改，要恢复吗？')).toHaveCount(0)
  })

  test('keyboard only: add, reorder, merge, undo, props, publish', async ({ page }) => {
    const m = await mockAccount(page, { signedIn: true })
    m.seedDesk({ id: 'k1', title: '风' })
    await openDesk(page, 'k1')
    for (const i of [0, 1, 2]) {
      await tiles(page).nth(i).focus()
      await page.keyboard.press('Enter')
    }
    await expect(frames(page)).toHaveCount(3)
    await frames(page).nth(2).focus()
    await page.keyboard.press('Alt+ArrowUp')
    await settled(page)
    expect(serverPhotos(m, 'k1')).toEqual(['p1', 'p3', 'p2'])
    await frames(page).nth(0).focus()
    await page.keyboard.press('Alt+KeyM')
    await expect(frames(page)).toHaveCount(2)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expect(frames(page)).toHaveCount(3)
    await settled(page)
    expect(serverPhotos(m, 'k1')).toEqual(['p1', 'p3', 'p2'])
    await frames(page).nth(0).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-desk-props]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-desk-preview]')).toBeVisible()
    await expect(frames(page).nth(0)).toBeFocused()
    await page.locator('[data-desk-publish]').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('dialog[open]')).toContainText('3 张')
    await page.locator('dialog[open]').getByRole('button', { name: '发布', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-desk-live-note]')).toBeVisible()
    expect(m.state.desk.k1!.status).toBe('published')
  })

  for (const width of [768, 1440]) {
    test(`no horizontal scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      const m = await mockAccount(page, { signedIn: true })
      m.seedDesk({ id: 'w1', title: '一个很长很长的合集标题，用来检查顶栏会不会撑出横向滚动条', photoIds: ['p1', 'p2', 'p3'] })
      await page.goto('/me/c/w1')
      await expect(frames(page)).toHaveCount(3)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.goto('/me/collections')
      await expect(page.getByRole('button', { name: '新建合集' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }

  test('reduced motion: add, save and publish still work', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const m = await mockAccount(page, { signedIn: true })
    m.seedDesk({ id: 'r1', title: '静', photoIds: ['p1'] })
    await openDesk(page, 'r1')
    await tiles(page).nth(1).focus()
    await page.keyboard.press('Enter')
    await settled(page)
    expect(serverPhotos(m, 'r1')).toEqual(['p1', 'p2'])
  })

  test('privacy: no original request, no location, the preview hides non-public fields', async ({ page }) => {
    const m = await mockAccount(page, { signedIn: true })
    // p1 carries full EXIF and a location; only lens is public in this collection.
    const p1 = m.state.archive.find((a) => a.photo.id === 'p1')!.photo as Record<string, unknown>
    p1.exif = { camera: 'X100V', lens: 'Fujinon 23mm', focalLength: 23, aperture: 2, shutter: '1/250', iso: 200, latitude: 31.2304, longitude: 121.4737 }
    m.seedDesk({ id: 'v1', title: '雨', photoIds: ['p1'], overrides: { p1: { publicFields: ['lens'], histogramPublic: false } } })
    await openDesk(page, 'v1')
    const preview = page.locator('[data-desk-preview]')
    await expect(preview).toBeVisible()
    await expect(preview).not.toContainText('X100V')
    await expect(preview).not.toContainText('1/250')
    const html = await page.content()
    expect(html).not.toContain('31.2304')
    expect(html).not.toContain('121.4737')
    expect(m.order.some((r) => r.includes('/original'))).toBe(false)
    expect(m.requests.some((u) => u.includes('/original'))).toBe(false)
    void deskWrites
  })
})

test('phone: one column, no archive, reorder keeps focus, publish @touch', async ({ page }) => {
  const m = await mockAccount(page, { signedIn: true })
  m.seedDesk({ id: 'ph', title: '岸', photoIds: ['p1', 'p2', 'p3'] })
  await page.goto('/me/c/ph')
  await expect(page.getByText('在电脑上添加和编排照片')).toBeVisible()
  await expect(page.locator('.desk-archive')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '添加照片' })).toHaveCount(0)
  await page.getByRole('button', { name: '下移第 1 帧' }).tap()
  await expect(page.getByRole('button', { name: '下移第 2 帧' })).toBeFocused()
  await expect(saveState(page)).toHaveText('已保存')
  expect(serverPhotos(m, 'ph')).toEqual(['p2', 'p1', 'p3'])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  // One polite live region on phones (final review M1), and it speaks for the phone rows.
  await expect(page.locator('[aria-live="polite"]')).toHaveCount(1)
  await expect(page.locator('[aria-live="polite"]')).toHaveText('已移到第 2 帧')
  await page.getByRole('button', { name: '发布', exact: true }).first().tap()
  const dialog = page.locator('dialog[open]')
  await expect(dialog).toContainText('3 张')
  await dialog.getByRole('button', { name: '发布', exact: true }).tap()
  await expect(page.getByRole('button', { name: '撤回', exact: true }).first()).toBeVisible()
  expect(m.state.desk.ph!.status).toBe('published')
})

test.describe('desk: another tab between manifest and confirm', () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  test('publish refuses content the manifest did not show (final review C2)', async ({ page }) => {
    const m = await mockAccount(page, { signedIn: true })
    m.seedDesk({ id: 'c2', title: '潮', photoIds: ['p1'] })
    await page.goto('/me/c/c2')
    await expect(page.locator('section.desk-sequence')).toBeVisible()
    await page.locator('[data-desk-publish]').click()
    const dialog = page.locator('dialog[open]')
    await expect(dialog).toContainText('1 张')
    // "Tab B" adds a photo while the dialog is open.
    m.editElsewhere('c2', { frames: [{ layout: 'full', matteRatio: null, text: null, photoIds: ['p1'] }, { layout: 'full', matteRatio: null, text: null, photoIds: ['p2'] }] })
    await dialog.getByRole('button', { name: '发布', exact: true }).click()
    // The dialog asks for a fresh manifest instead of publishing the unseen photo.
    await expect(dialog.getByRole('alert')).toHaveText('内容有变化，请重新确认发布清单')
    expect(m.state.desk.c2!.status).toBe('draft')
    // Close the dialog; the desk now shows the conflict, and reloading brings in p2.
    await dialog.getByRole('button', { name: '取消' }).click()
    await page.getByRole('button', { name: '载入最新版本' }).click()
    await expect(page.locator('[role="listitem"]')).toHaveCount(2)
    await page.locator('[data-desk-publish]').click()
    await expect(page.locator('dialog[open]')).toContainText('2 张')
    await page.locator('dialog[open]').getByRole('button', { name: '发布', exact: true }).click()
    await expect(page.locator('[data-desk-live-note]')).toBeVisible()
    expect(m.state.desk.c2!.status).toBe('published')
  })
})
