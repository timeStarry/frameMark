// Acceptance for the collection viewer (spec §9 table). Every API and media
// request is served by e2e/mock.ts.
import { expect, test, type Page } from '@playwright/test'
import { mockAPI } from './mock'

const current = (page: Page) => page.locator('.frame-slot:not([aria-hidden])')

async function frameNo(page: Page): Promise<string | null> {
  return current(page).getAttribute('data-frame')
}

async function waitFrame(page: Page, n: number) {
  await expect(current(page)).toHaveAttribute('data-frame', String(n))
  // Let the 280ms move settle before geometry checks.
  await page.waitForTimeout(350)
}

async function screen(page: Page, name: string) {
  const w = page.viewportSize()?.width ?? 0
  await page.screenshot({ path: `test-results/screens/${test.info().project.name}-${w}-${name}.png` })
}

test.describe('layouts at four widths', () => {
  for (const width of [360, 390, 768, 1440]) {
    test(`frames fit the safe area at ${width}px`, async ({ page }) => {
      const height = width < 768 ? 780 : 900
      await page.setViewportSize({ width, height })
      await mockAPI(page)
      await page.goto('/c/main')
      const names = ['land', 'port', 'pano', 'pair', 'text', 'land2']
      for (let n = 1; n <= 6; n++) {
        if (n > 1) {
          await page.keyboard.press('ArrowDown')
          // A stacked pair or a long text scrolls internally first.
          for (let i = 0; i < 4 && (await frameNo(page)) !== String(n); i++) await page.keyboard.press('ArrowDown')
        }
        await waitFrame(page, n)
        const imgs = current(page).locator('img')
        const count = await imgs.count()
        const stacked = await current(page).locator('.pair.stacked').count()
        for (let i = 0; i < count; i++) {
          await expect(imgs.nth(i)).toHaveJSProperty('complete', true)
          if (stacked) continue // stacked pairs scroll; they need not fit at once
          const b = (await imgs.nth(i).boundingBox())!
          expect(b.x).toBeGreaterThanOrEqual(-0.5)
          expect(b.y).toBeGreaterThanOrEqual(-0.5)
          expect(b.x + b.width).toBeLessThanOrEqual(width + 0.5)
          expect(b.y + b.height).toBeLessThanOrEqual(height + 0.5)
          expect(b.width).toBeGreaterThan(50)
        }
        const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
        expect(scrollW).toBeLessThanOrEqual(width)
        await screen(page, names[n - 1]!)
      }
    })
  }
})

test('keyboard-only: page through, open info, next collection, back', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/')
  await page.goto('/c/main')
  await waitFrame(page, 1)
  await page.keyboard.press('i')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toBeFocused()
  await page.keyboard.press('i')
  await expect(dialog).toHaveCount(0)
  await page.keyboard.press('End')
  await waitFrame(page, 7)
  await expect(page.getByText('下一组')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/\/c\/next/)
  await expect(page).toHaveTitle('山中 · 林 — Markr')
  // Every Tab stop on an edge is visible, shows its edge and has a focus ring (spec §9, at every step).
  // Safari only tabs to buttons and links with Option+Tab by default.
  const seen: string[] = []
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      const edge = el?.closest('[data-edge]')
      if (!el || !edge) return null
      return {
        label: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
        shown: edge.classList.contains('shown'),
        outline: getComputedStyle(el).outlineStyle,
      }
    })
    if (!info) break
    if (seen.includes(info.label)) break
    seen.push(info.label)
    await expect(page.locator(':focus')).toBeVisible()
    expect(info.shown, info.label).toBe(true)
    expect(info.outline, info.label).not.toBe('none')
  }
  expect(seen.length).toBeGreaterThanOrEqual(3)
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/$/)
})

test('wheel: one burst pages exactly one frame', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/c/main')
  await waitFrame(page, 1)
  await page.mouse.move(720, 450)
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, 30)
    await page.waitForTimeout(16)
  }
  await waitFrame(page, 2)
  await page.waitForTimeout(600)
  await page.mouse.wheel(0, 120)
  await waitFrame(page, 3)
})

test.describe('touch @touch', () => {
  async function swipe(page: Page, from: [number, number], to: [number, number], steps = 6, stepMs = 16) {
    await page.evaluate(
      async ({ from, to, steps, stepMs }) => {
        // Start on the topmost element (usually the <img>): implicit capture must not kill the swipe.
        const target = document.elementFromPoint(from[0], from[1])!
        const fire = (type: string, x: number, y: number, t: EventTarget) =>
          t.dispatchEvent(
            new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: type === 'pointerup' ? 0 : 1 }),
          )
        fire('pointerdown', from[0], from[1], target)
        for (let i = 1; i <= steps; i++) {
          const x = from[0] + ((to[0] - from[0]) * i) / steps
          const y = from[1] + ((to[1] - from[1]) * i) / steps
          await new Promise((r) => setTimeout(r, stepMs))
          fire('pointermove', x, y, target)
        }
        fire('pointerup', to[0], to[1], target)
      },
      { from, to, steps, stepMs },
    )
  }

  test('a horizontal drag shows the next collection cover beside the photo', async ({ page }) => {
    await mockAPI(page)
    await page.goto('/c/main')
    await waitFrame(page, 1)
    await page.waitForTimeout(300)
    const vp = page.viewportSize()!
    const cx = vp.width / 2
    const cy = vp.height / 2
    const mid = await page.evaluate(
      async ({ cx, cy }) => {
        const target = document.elementFromPoint(cx, cy)!
        const fire = (type: string, x: number) =>
          target.dispatchEvent(new PointerEvent(type, { pointerId: 8, pointerType: 'touch', isPrimary: true, clientX: x, clientY: cy, bubbles: true, cancelable: true, buttons: 1 }))
        fire('pointerdown', cx)
        for (let i = 1; i <= 6; i++) {
          await new Promise((r) => setTimeout(r, 30))
          fire('pointermove', cx - i * 15)
        }
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        const peek = document.querySelector('.peek-next')
        const r = peek?.getBoundingClientRect()
        const img = peek?.querySelector('img')
        const out = { peek: !!peek, left: r?.left ?? null, src: img?.currentSrc || img?.getAttribute('src') || '' }
        fire('pointercancel', cx - 90)
        return out
      },
      { cx, cy },
    )
    expect(mid.peek).toBe(true)
    expect(mid.left).toBeCloseTo(vp.width - 90, 0)
    expect(mid.src).toContain('next-cover')
    await expect(page.locator('.peek')).toHaveCount(0)
    await expect(page).toHaveURL(/\/c\/main/)
  })

  test('swipe up from the bottom edge opens info; drag the drawer down closes it', async ({ page }) => {
    await mockAPI(page)
    // A photo with no public fields: no right edge, so this is the only way in on a phone.
    await page.goto('/c/main?f=3')
    await waitFrame(page, 3)
    await expect(page.locator('.edge-right button')).toHaveCount(0)
    const vp = page.viewportSize()!
    const cx = vp.width / 2
    await swipe(page, [cx, vp.height - 6], [cx, vp.height - 320], 8, 16)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveClass(/drawer/)
    await page.waitForTimeout(350)
    await expect(current(page)).toHaveAttribute('data-frame', '3')
    const d = (await dialog.boundingBox())!
    await swipe(page, [cx, d.y + 20], [cx, d.y + 20 + d.height * 0.5], 8, 16)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(current(page)).toHaveAttribute('data-frame', '3')
  })

  test('swipe up from the image pages; slow short drag springs back; swipe left changes collection; tap toggles edges', async ({ page }) => {
    await mockAPI(page)
    await page.goto('/c/main')
    await waitFrame(page, 1)
    const vp = page.viewportSize()!
    const cx = vp.width / 2
    const cy = vp.height / 2
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.tagName, [cx, cy])
    expect(hit).toBe('IMG')
    await swipe(page, [cx, cy + 150], [cx, cy - 150])
    await waitFrame(page, 2)
    await swipe(page, [cx, cy + 20], [cx, cy - 40], 10, 60)
    await waitFrame(page, 2)
    await expect(page.locator('.edge-top')).not.toHaveClass(/shown/)
    await page.touchscreen.tap(cx, cy)
    await expect(page.locator('.edge-top')).toHaveClass(/shown/)
    await page.waitForTimeout(400)
    await swipe(page, [cx + 120, cy], [cx - 120, cy])
    await expect(page).toHaveURL(/\/c\/next/)
  })
})

test('edges: left scale appears near the edge; all hide after 2s idle with cursor none', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/c/main')
  await waitFrame(page, 1)
  await page.mouse.move(700, 450)
  await page.mouse.move(20, 450)
  await expect(page.locator('.edge-left')).toHaveClass(/shown/)
  await expect(page.getByRole('button', { name: '跳到第 1 帧' })).toBeVisible()
  await page.waitForTimeout(2300)
  await expect(page.locator('.edge-left')).not.toHaveClass(/shown/)
  const cursor = await page.locator('.stage').evaluate((el) => getComputedStyle(el).cursor)
  expect(cursor).toBe('none')
})

test('cover strip: every card is reachable at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await mockAPI(page)
  await page.goto('/c/long')
  await waitFrame(page, 1)
  await page.mouse.move(180, 400)
  await page.mouse.move(180, 770)
  const strip = page.locator('.edge-bottom .strip')
  await expect(page.locator('.edge-bottom')).toHaveClass(/shown/)
  const cards = strip.locator('button')
  await expect(cards).toHaveCount(10)
  await strip.evaluate((el) => (el.scrollLeft = 0))
  const s = (await strip.boundingBox())!
  const first = (await cards.first().boundingBox())!
  expect(first.x).toBeGreaterThanOrEqual(s.x - 0.5)
  await strip.evaluate((el) => (el.scrollLeft = el.scrollWidth))
  const last = (await cards.last().boundingBox())!
  expect(last.x + last.width).toBeLessThanOrEqual(s.x + s.width + 0.5)
})

/** Every point ±21px from the control's centre hits the control (44×44 hit area, §6.2). */
async function expectHit44(page: Page, sel: string, nth = 0) {
  const misses = await page.locator(sel).nth(nth).evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const out: string[] = []
    for (const [dx, dy] of [[0, 0], [-21, 0], [21, 0], [0, -21], [0, 21]] as const) {
      const hit = document.elementFromPoint(cx + dx, cy + dy)
      if (!hit || !(hit === el || el.contains(hit))) out.push(`${dx},${dy}`)
    }
    return out
  })
  expect(misses, sel).toEqual([])
}

test('touch targets are at least 44×44px at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await mockAPI(page)
  await page.goto('/c/main')
  await waitFrame(page, 1)
  await page.mouse.move(195, 400)
  await page.mouse.move(10, 400)
  await expect(page.locator('.edge-left')).toHaveClass(/shown/)
  const col = (await page.locator('.edge-left .ticks').boundingBox())!
  expect(col.width).toBeGreaterThanOrEqual(44)
  // 6 ticks: each one is its own 44px target.
  await expectHit44(page, '.edge-left .tick', 0)
  await expectHit44(page, '.edge-left .tick', 5)
  await page.mouse.move(380, 400)
  await expectHit44(page, '.edge-right .params')
  await page.keyboard.press('i')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.waitForTimeout(350)
  await expectHit44(page, '[role=dialog] button[aria-label="关闭"]')
  await expectHit44(page, '[role=dialog] .modes button', 0)
  await expectHit44(page, '[role=dialog] .modes button', 1)
  await page.keyboard.press('Escape')
  await page.goto('/c/main?f=4')
  await waitFrame(page, 4)
  await page.keyboard.press('i')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.waitForTimeout(350)
  await expectHit44(page, '[role=dialog] .switch button', 0)
  await expectHit44(page, '[role=dialog] .switch button', 1)
})

test('short landscape: a scale that does not fit becomes a tap column and the last frame is reachable', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 })
  await mockAPI(page)
  await page.goto('/c/many')
  await waitFrame(page, 1)
  await page.mouse.move(400, 200)
  await page.mouse.move(10, 200)
  await expect(page.locator('.edge-left')).toHaveClass(/shown/)
  const hit = page.locator('.edge-left [data-edge-hit]')
  await expect(hit).toHaveCount(1)
  const b = (await hit.boundingBox())!
  expect(b.width).toBeGreaterThanOrEqual(44)
  // The column is fully inside the viewport: nothing clipped.
  expect(b.y).toBeGreaterThanOrEqual(0)
  expect(b.y + b.height).toBeLessThanOrEqual(390)
  await page.mouse.click(b.x + b.width / 2, b.y + b.height - 2)
  await waitFrame(page, 10)
})

test.describe('info layer', () => {
  test('wide: panel narrows the stage without covering the photo; histogram toggles', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockAPI(page)
    await page.goto('/c/main')
    await waitFrame(page, 1)
    await page.keyboard.press('i')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await page.waitForTimeout(350)
    const d = (await dialog.boundingBox())!
    expect(Math.round(d.width)).toBe(360)
    const img = (await current(page).locator('img').boundingBox())!
    expect(img.x + img.width).toBeLessThanOrEqual(d.x + 0.5)
    const luma = dialog.getByRole('button', { name: '亮度' })
    const rgb = dialog.getByRole('button', { name: 'RGB' })
    await expect(luma).toHaveAttribute('aria-pressed', 'true')
    await rgb.click()
    await expect(rgb).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.locator('svg[aria-label="直方图"] path')).toHaveCount(3)
    await screen(page, 'info-panel')
  })

  test('narrow: drawer; a photo with no public fields has no parameter line', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 })
    await mockAPI(page)
    await page.goto('/c/main?f=3')
    await waitFrame(page, 3)
    await expect(page.locator('.edge-right button')).toHaveCount(0)
    await page.keyboard.press('i')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveClass(/drawer/)
    const d = (await dialog.boundingBox())!
    expect(d.height).toBeLessThanOrEqual(780 * 0.6 + 1)
    await screen(page, 'info-drawer')
    await dialog.getByRole('button', { name: '关闭' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})

test('reduced motion: no transition when paging', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/c/main')
  await waitFrame(page, 1)
  const dur = await page.locator('.track').evaluate((el) => getComputedStyle(el).transitionDuration)
  expect(dur.split(',').every((d) => parseFloat(d) === 0)).toBe(true)
})

test('slow media stays black, a failed image shows a notice and paging still works', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page, { mediaDelayMs: 1500 })
  await page.goto('/c/broken')
  await expect(current(page)).toHaveAttribute('data-frame', '1')
  // While the image is in flight: a real <img>, not loaded yet, on black, with no placeholder or skeleton.
  await page.waitForTimeout(300)
  const state = await current(page).evaluate((slot) => {
    const img = slot.querySelector('img')
    const black = (el: Element | null) => {
      for (let e = el; e; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor
        if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c === 'rgb(0, 0, 0)'
      }
      return false
    }
    return {
      img: !!img,
      complete: img?.complete ?? null,
      natural: img?.naturalWidth ?? null,
      black: black(img),
      fillers: slot.querySelectorAll('.placeholder, [class*="skeleton"], [class*="spinner"], [role="progressbar"]').length,
    }
  })
  expect(state).toEqual({ img: true, complete: false, natural: 0, black: true, fillers: 0 })
  await expect(current(page).getByText('图片暂时无法加载')).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('ArrowDown')
  await waitFrame(page, 2)
})

test('end frame: entries work and continuing down enters the next collection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/c/main?f=7')
  await waitFrame(page, 7)
  const end = current(page)
  await expect(end.getByText('从头再看')).toBeVisible()
  await expect(end.getByRole('link', { name: '作者主页' })).toHaveAttribute('href', '/u/u1')
  await expect(end.getByText('山中')).toBeVisible()
  await end.getByRole('button', { name: '从头再看' }).click()
  await waitFrame(page, 1)
  await page.keyboard.press('End')
  await waitFrame(page, 7)
  await page.keyboard.press('ArrowDown')
  await expect(page).toHaveURL(/\/c\/next/)
})

test('cross-author switch shows the new author and announces it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/c/main')
  await waitFrame(page, 1)
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/\/c\/next/)
  await expect(page.locator('.edge-top.shown')).toContainText('林')
  // The outgoing viewer keeps its own (empty) live region until its leave transition ends.
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: '林 的「山中」' })).toHaveCount(1)
})

test('collection switch: the outgoing viewer ignores keys during its leave transition', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/c/main?wall=square&f=3')
  await waitFrame(page, 3)
  // Let the neighbour prefetch land so the next collection mounts at once.
  await page.waitForTimeout(300)
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/\/c\/next/)
  // The new viewer starts at frame 1 and clamps on ↑; only the old one (frame 3) would write f=2.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('i')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.waitForTimeout(500)
  expect(new URL(page.url()).searchParams.get('f')).toBeNull()
  await expect(page.locator('.viewer')).toHaveCount(1)
})

test('URL: reload keeps the frame and the shared link has no wall', async ({ page, context, browserName }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockAPI(page)
  await page.goto('/c/main?wall=square')
  await waitFrame(page, 1)
  await page.keyboard.press('ArrowDown')
  await waitFrame(page, 2)
  await expect(page).toHaveURL(/f=2/)
  await page.reload()
  await waitFrame(page, 2)
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const shared = await page.evaluate(async () => {
    const calls: string[] = []
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => void calls.push(s) } })
    ;(window as unknown as { __calls: string[] }).__calls = calls
    return true
  })
  expect(shared).toBe(true)
  await page.mouse.move(700, 10)
  await page.getByRole('button', { name: '更多' }).click({ timeout: 5000 })
  await page.getByRole('menuitem', { name: '复制链接' }).click({ timeout: 5000 })
  await expect(page.getByText('已复制链接')).toBeVisible()
  const url = await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls[0])
  expect(url).toMatch(/\/c\/main\?f=2$/)
  expect(url).not.toContain('wall')
})

test('privacy: no location, no original keys and no original prefetch', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const mock = await mockAPI(page)
  await page.goto('/c/main')
  await waitFrame(page, 1)
  await page.keyboard.press('i')
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(500)
  const text = (await page.content()).toLowerCase()
  for (const s of ['latitude', 'longitude', '/o/']) {
    expect(text).not.toContain(s)
    expect(mock.requests.some((u) => u.toLowerCase().includes(s))).toBe(false)
  }
  expect(mock.requests.some((u) => u.includes('/original'))).toBe(false)
  const preloads = await page.locator('link[rel="preload"]').evaluateAll((ls) => ls.map((l) => l.getAttribute('imagesrcset') ?? ''))
  expect(preloads.some((s) => s.includes('original'))).toBe(false)
})

test('404 collection shows the missing screen', async ({ page }) => {
  await mockAPI(page)
  await page.goto('/c/gone')
  await expect(page.getByText('这组照片不存在或已不再公开')).toBeVisible()
})
