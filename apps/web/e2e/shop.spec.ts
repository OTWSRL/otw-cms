import { expect, test } from '@playwright/test'

test('a shopper finds the shop through the plugin slot and places an order', async ({ page }) => {
  // The home page is the CMS's: the latest posts, as Settings › Reading has it by default.
  await page.goto('/')
  await expect(page.locator('main .archive')).toBeVisible()

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Shop' }).click()
  await expect(page).toHaveURL('/shop')
  await expect(page).toHaveTitle('Shop · My Site')
  // The admin specs add products too, so check for the seeded ones rather than a count.
  for (const name of ['Canvas Tote', 'Ceramic Mug', 'Field Notebook']) {
    await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible()
  }

  await page.getByRole('link', { name: /Ceramic Mug/ }).click()
  await expect(page).toHaveURL('/product/ceramic-mug')
  await expect(page).toHaveTitle('Ceramic Mug · My Site')
  await expect(page.getByText('$18.00')).toBeVisible()

  await page.getByLabel('Email').fill('ana@example.com')
  await page.getByLabel('Quantity').fill('2')
  await page.getByLabel(/Pay later/).check()
  await page.getByRole('button', { name: 'Place order' }).click()

  await expect(page).toHaveURL(/\/order\/[0-9a-f-]{36}\/received$/)
  await expect(page.getByRole('heading', { name: /^Order #\d+$/ })).toBeVisible()
  await expect(page.getByTestId('order-status')).toHaveText('Awaiting payment')
  await expect(page.getByTestId('order-total')).toHaveText('$36.00')
})

test('visitors download none of the admin’s code', async ({ page }) => {
  const scripts: string[] = []
  // Read on the way in: a body read from the response event is gone once the page moves on.
  await page.route(
    (url) => url.pathname.endsWith('.js'),
    async (route) => {
      const response = await route.fetch()
      scripts.push(await response.text())
      await route.fulfill({ response })
    },
  )
  // Text only the admin's client components carry: its menu, notices and list tables.
  const markers = ['wp-not-current-submenu', 'Dismiss this notice.', 'Show more details']
  const carrying = (marker: string) => scripts.filter((code) => code.includes(marker)).length

  for (const path of ['/', '/shop', '/product/ceramic-mug']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
  }
  for (const marker of markers) expect(carrying(marker), marker).toBe(0)

  // The admin's own pages do carry them, so the markers are the right ones.
  await page.goto('/admin/login')
  await page.waitForLoadState('networkidle')
  for (const marker of markers) expect(carrying(marker), marker).toBeGreaterThan(0)
})

test('only configured gateways are offered', async ({ page }) => {
  await page.goto('/product/canvas-tote')
  await expect(page.getByRole('radio')).toHaveCount(1)
  await expect(page.getByLabel(/Pay later/)).toBeChecked()
})

test('a rejected checkout sends the shopper back with an explanation', async ({ page }) => {
  await page.goto('/product/field-notebook')
  // Skip browser validation to exercise the server-side check.
  await page
    .locator('form.commerce-checkout')
    .evaluate((form) => form.setAttribute('novalidate', ''))
  await page.getByLabel('Email').fill('not-an-email')
  await page.getByRole('button', { name: 'Place order' }).click()

  await expect(page).toHaveURL('/product/field-notebook?checkout_error=invalid_input')
  // Next renders its own (empty) role="alert" route announcer, so match on the message itself.
  await expect(page.getByText('Please check your email address and quantity.')).toHaveAttribute(
    'role',
    'alert',
  )
})

test('unknown pages return 404', async ({ page }) => {
  expect((await page.goto('/no-such-page'))?.status()).toBe(404)
  expect((await page.goto('/product/no-such-product'))?.status()).toBe(404)
  expect((await page.goto('/order/not-an-id/received'))?.status()).toBe(404)
})

test('the plugin API validates input and blocks cross-site posts', async ({ request }) => {
  const invalid = await request.post('/api/p/commerce/checkout', {
    data: { email: 'nope', gateway: 'manual', lines: [] },
  })
  expect(invalid.status()).toBe(400)

  const crossSite = await request.post('/api/p/commerce/checkout', {
    headers: { origin: 'https://evil.test' },
    form: { email: 'a@b.co', gateway: 'manual', item_type: 'product', item_id: 'x' },
  })
  expect(crossSite.status()).toBe(403)

  expect((await request.get('/api/p/nobody/here')).status()).toBe(404)
})
