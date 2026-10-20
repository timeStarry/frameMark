// Full-stack smoke against a real `markr serve` with the demo seed. Runs only
// when MARKR_E2E_BASE (and MARKR_E2E_COLLECTION) are set.
import { expect, test } from '@playwright/test'

const base = process.env.MARKR_E2E_BASE
const id = process.env.MARKR_E2E_COLLECTION

test('real server: first frame image loads under the CSP', async ({ page }) => {
  test.skip(!base || !id, 'MARKR_E2E_BASE / MARKR_E2E_COLLECTION not set')
  await page.goto(`${base!.replace(/\/+$/, '')}/c/${encodeURIComponent(id!)}`)
  const img = page.locator('.frame-slot:not([aria-hidden]) img').first()
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
})
