import { expect, test } from '@playwright/test'

// Plugins on the site, with the Library fixture (fixtures/library): their pages, their slots and
// their API, and what the CMS guarantees around them.

test('a visitor finds a plugin’s pages through its slot in the main navigation', async ({
  page,
}) => {
  // The home page is the CMS's: the latest posts, as Settings › Reading has it by default.
  await page.goto('/')
  await expect(page.locator('main .archive')).toBeVisible()

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Library' })
    .click()
  await expect(page).toHaveURL('/library')
  await expect(page).toHaveTitle('Library · My Site')

  await page.getByRole('link', { name: 'Middlemarch' }).click()
  await expect(page).toHaveURL('/library/middlemarch')
  await expect(page).toHaveTitle('Middlemarch · My Site')
  await expect(page.getByText('George Eliot')).toBeVisible()
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

  for (const path of ['/', '/library', '/library/middlemarch']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
  }
  for (const marker of markers) expect(carrying(marker), marker).toBe(0)

  // The admin's own pages do carry them, so the markers are the right ones.
  await page.goto('/admin/login')
  await page.waitForLoadState('networkidle')
  for (const marker of markers) expect(carrying(marker), marker).toBeGreaterThan(0)
})

test('unknown pages return 404', async ({ page }) => {
  expect((await page.goto('/no-such-page'))?.status()).toBe(404)
  // A plugin's page whose load finds nothing.
  expect((await page.goto('/library/no-such-book'))?.status()).toBe(404)
})

test('a plugin’s API checks its own input, and cross-site posts never reach it', async ({
  request,
}) => {
  const invalid = await request.post('/api/p/library/loans', { data: { book: 'no-such-book' } })
  expect(invalid.status()).toBe(400)

  const valid = await request.post('/api/p/library/loans', { data: { book: 'middlemarch' } })
  expect(valid.status()).toBe(201)
  expect(await valid.json()).toEqual({ book: 'middlemarch' })

  const crossSite = await request.post('/api/p/library/loans', {
    headers: { origin: 'https://evil.test' },
    form: { book: 'middlemarch' },
  })
  expect(crossSite.status()).toBe(403)

  expect((await request.get('/api/p/nobody/here')).status()).toBe(404)
})
