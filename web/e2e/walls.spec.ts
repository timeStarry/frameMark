// Acceptance for the walls (SP3 spec §9, task-6 addendum). Every API and media
// request is served by e2e/mock.ts.
import { expect, test, type Page } from '@playwright/test'
import { mockAPI, SQUARE_ORDER, USER_U2 } from './mock'

const cards = (page: Page) => page.locator('a.card[data-card-id]')
const cardById = (page: Page, id: string) => page.locator(`a.card[data-card-id="${id}"]`)

/** Safari only moves focus to links with Option+Tab by default. */
const tabKey = (browserName: string) => (browserName === 'webkit' ? 'Alt+Tab' : 'Tab')

async function activeCardId(page: Page): Promise<string | null> {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.cardId ?? null)
}

/** Scroll until the second square page is on the wall. */
async function loadAllSquare(page: Page) {
  await expect(cards(page).first()).toBeVisible()
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        return cards(page).count()
      },
      { timeout: 10_000 },
    )
    .toBe(SQUARE_ORDER.length)
}

async function waitViewer(page: Page) {
  await expect(page.locator('.frame-slot:not([aria-hidden])')).toHaveAttribute('data-frame', '1')
}

/** Card boxes that intersect by more than 0.5px on both axes. */
async function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rs = Array.from(document.querySelectorAll<HTMLElement>('a.card[data-card-id]')).map((e) => ({
      id: e.dataset.cardId!,
      r: e.getBoundingClientRect(),
    }))
    const out: string[] = []
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i]!.r
        const b = rs[j]!.r
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (x > 0.5 && y > 0.5) out.push(`${rs[i]!.id}×${rs[j]!.id}`)
      }
    return out
  })
}

test.describe('no horizontal scroll at four widths', () => {
  for (const width of [360, 390, 768, 1440]) {
    for (const path of ['/', '/u/u1', '/a/al1']) {
      test(`${path} at ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width < 768 ? 780 : 900 })
        await mockAPI(page)
        await page.goto(path)
        await expect(cards(page).first()).toBeVisible()
        await expect(cards(page).first().locator('.cover img')).toHaveJSProperty('complete', true)
        const sw = await page.evaluate(() => document.documentElement.scrollWidth)
        expect(sw).toBeLessThanOrEqual(width)
        await testInfo.attach(`${testInfo.project.name}-${width}${path.replace(/\//g, '_')}.png`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
      })
    }
  }
})

test.describe('masonry in a real browser', () => {
  for (const width of [768, 1440]) {
    test(`/ (salon) at ${width}px: no overlap, DOM and Tab order follow the fixture`, async ({ page, browserName }) => {
      await page.setViewportSize({ width, height: 900 })
      await mockAPI(page)
      await page.goto('/')
      await loadAllSquare(page)
      await expect.poll(() => overlaps(page)).toEqual([])
      const ids = await cards(page).evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.cardId))
      expect(ids).toEqual(SQUARE_ORDER)
      await page.locator('nav a').last().focus()
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press(tabKey(browserName))
        expect(await activeCardId(page)).toBe(SQUARE_ORDER[i])
      }
    })

    test(`/u/u2 (grid) at ${width}px: no overlap, DOM and Tab order follow the fixture`, async ({ page, browserName }) => {
      await page.setViewportSize({ width, height: 900 })
      await mockAPI(page)
      await page.goto('/u/u2')
      await expect(cards(page)).toHaveCount(USER_U2.collections.length)
      await expect.poll(() => overlaps(page)).toEqual([])
      const order = USER_U2.collections.map((c) => c.id)
      const ids = await cards(page).evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.cardId))
      expect(ids).toEqual(order)
      await page.locator('nav a').last().focus()
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press(tabKey(browserName))
        expect(await activeCardId(page)).toBe(order[i])
      }
    })
  }
})

test('square round trip: page 2 → viewer → Esc restores focus and view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/')
  await loadAllSquare(page)
  expect(SQUARE_ORDER[29]).toBe('main')
  const target = cards(page).nth(29)
  await expect(target).toHaveAttribute('data-card-id', 'main')
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await expect(page).toHaveURL(/\/c\/main\?wall=square/)
  await waitViewer(page)
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/127\.0\.0\.1:4173\/$/)
  const back = cardById(page, 'main')
  await expect(back).toBeFocused()
  await expect(back).toBeInViewport()
})

test('user page, keyboard only: Tab to the second card, Enter, Esc back with focus', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/u/u1')
  await expect(cards(page).nth(1)).toHaveAttribute('data-card-id', 'main')
  await page.locator('nav a').last().focus()
  const seen: (string | null)[] = []
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press(tabKey(browserName))
    seen.push(await activeCardId(page))
  }
  expect(seen).toEqual(['solo', 'main'])
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/c\/main\?wall=user(%3A|:)u1/)
  await waitViewer(page)
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/u\/u1$/)
  await expect(cardById(page, 'main')).toBeFocused()
  await expect(cardById(page, 'main')).toBeInViewport()
})

test('direct link with a user wall: 返回 lands on the owner page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/c/main?wall=user:u1')
  await waitViewer(page)
  // Approach the top edge so it reveals itself, then click 返回.
  await page.mouse.move(720, 450)
  await page.mouse.move(720, 20, { steps: 5 })
  await expect(page.locator('.edge-top')).toHaveClass(/shown/)
  await page.getByRole('button', { name: '返回' }).click()
  await expect(page).toHaveURL(/\/u\/u1$/)
  await expect(page.getByRole('heading', { name: '阿树' })).toBeVisible()
})

test('sweep: three bands show three previews, leaving shows the cover; box height fixed; preview tiers capped', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const mock = await mockAPI(page)
  await page.goto('/u/u1')
  // `main`: previews are land / port / land, cover land.
  const card = cardById(page, 'main')
  const frame = card.locator('.frame')
  const img = frame.locator(':scope > .cover img')
  await expect(img).toHaveJSProperty('complete', true)
  const box = (await frame.boundingBox())!
  const h0 = (await card.boundingBox())!.height
  const src = () => img.evaluate((e: HTMLImageElement) => e.currentSrc)
  expect(await src()).toContain('/main-cover/')
  const y = box.y + box.height / 2
  await page.mouse.move(box.x - 20, y)
  for (const [band, id] of [
    [0, 'main-p1'],
    [1, 'main-p2'],
    [2, 'main-p3'],
  ] as const) {
    await page.mouse.move(box.x + (box.width * (band + 0.5)) / 3, y, { steps: 4 })
    await expect.poll(src).toContain(`/${id}/`)
    expect(Math.abs((await card.boundingBox())!.height - h0)).toBeLessThanOrEqual(0.5)
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 200)
  await expect.poll(src).toContain('/main-cover/')
  expect(Math.abs((await card.boundingBox())!.height - h0)).toBeLessThanOrEqual(0.5)
  const previews = mock.requests.filter((u) => /\/main-p\d\//.test(u))
  expect(previews.length).toBeGreaterThan(0)
  for (const u of previews) expect(u).toMatch(/\/(w480|w1280)\./)
})

test.describe('touch @touch', () => {
  test('cards show dots, a touch drag does not sweep, a tap opens the viewer', async ({ page }) => {
    await mockAPI(page)
    await page.goto('/u/u1')
    const card = cardById(page, 'main')
    await expect(card.locator('.dots')).toBeVisible()
    await expect(card.locator('.dots i')).toHaveCount(5)
    const img = card.locator('.frame > .cover img')
    await expect(img).toHaveJSProperty('complete', true)
    await card.scrollIntoViewIfNeeded()
    const box = (await card.locator('.frame').boundingBox())!
    // A touch pointer moving across the cover must not change the image or mount previews.
    await card.locator('.frame').evaluate((el, b) => {
      const fire = (type: string, x: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: x, clientY: b.y + b.height / 2, bubbles: true }))
      fire('pointerenter', b.x + 2)
      for (let i = 1; i <= 5; i++) fire('pointermove', b.x + (b.width * i) / 6)
    }, box)
    await expect(card.locator('.preload')).toHaveCount(0)
    expect(await img.evaluate((e: HTMLImageElement) => e.currentSrc)).toContain('/main-cover/')
    await card.tap()
    await expect(page).toHaveURL(/\/c\/main\?wall=user(%3A|:)u1/)
    await waitViewer(page)
  })
})

test('broken cover keeps its box and its caption', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/')
  const card = cardById(page, 'broken')
  await card.scrollIntoViewIfNeeded()
  const cover = card.locator('.cover')
  await expect(cover).toHaveClass(/failed/)
  expect((await cover.boundingBox())!.height).toBeGreaterThan(50)
  await expect(card.locator('.line')).toContainText('坏图')
})

test('slow network: 载入中 shows while page 2 is pending', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page, { squareDelayMs: 2000 })
  await page.goto('/')
  await expect(cards(page)).toHaveCount(26)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect(page.getByRole('status').filter({ hasText: '载入中' })).toBeVisible()
  await expect(cards(page)).toHaveCount(SQUARE_ORDER.length, { timeout: 10_000 })
  await expect(page.getByText('载入中')).toHaveCount(0)
})

test('reduced motion: the round trip still restores focus', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/a/al1')
  const target = cardById(page, 'next')
  await target.click()
  await expect(page).toHaveURL(/\/c\/next\?wall=album(%3A|:)al1/)
  await waitViewer(page)
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/a\/al1$/)
  await expect(cardById(page, 'next')).toBeFocused()
  await expect(cardById(page, 'next')).toBeInViewport()
})

test('privacy: wall pages fetch no originals and render no location', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const mock = await mockAPI(page)
  for (const path of ['/', '/u/u1', '/a/al1']) {
    await page.goto(path)
    await expect(cards(page).first()).toBeVisible()
    const b = (await cards(page).first().locator('.frame').boundingBox())!
    await page.mouse.move(b.x + 5, b.y + b.height / 2)
    await page.mouse.move(b.x + b.width - 5, b.y + b.height / 2, { steps: 5 })
    const text = (await page.content()).toLowerCase()
    expect(text).not.toContain('latitude')
    expect(text).not.toContain('longitude')
  }
  expect(mock.requests.some((u) => u.includes('/original'))).toBe(false)
})
