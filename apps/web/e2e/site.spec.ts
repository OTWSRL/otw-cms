import { expect, test, type Browser, type Page } from '@playwright/test'
import { notice, signInAsAdmin } from './helpers'

// One site; each test builds on what the ones before published.
test.describe.configure({ mode: 'serial' })

/** A signed-out visitor, in a browser context of their own. */
async function visitor(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage()
}

/** Publishes an entry from Add New and returns its permalink, as the edit screen shows it. */
async function publish(
  page: Page,
  type: 'posts' | 'pages',
  title: string,
  extra?: () => Promise<unknown>,
  message = `${type === 'posts' ? 'Post' : 'Page'} published.`,
) {
  await page.goto(`/admin/${type}/new`)
  await page.getByLabel('Add title').fill(title)
  await extra?.()
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await notice(page, message)
  return page.locator('.entry-permalink a').getAttribute('href')
}

test('published pages and posts are on the site, at their paths', async ({ page, browser }) => {
  await signInAsAdmin(page)
  await page.goto('/admin/posts/categories')
  await page.getByLabel('Name', { exact: true }).fill('Markets')
  await page.getByRole('button', { name: 'Add New Category' }).click()
  await notice(page, 'Category added.')

  await publish(page, 'pages', 'Visit us')
  const times = await publish(page, 'pages', 'Opening times', () =>
    page.getByLabel('Parent').selectOption({ label: 'Visit us' }),
  )
  expect(times).toBe('/visit-us/opening-times')
  const market = await publish(page, 'posts', 'Market day', async () => {
    await page.getByRole('textbox', { name: /content$/ }).click()
    await page.keyboard.type('Stalls from nine.')
    await page.getByRole('checkbox', { name: 'Markets' }).check()
  })
  expect(market).toBe('/market-day')

  const guest = await visitor(browser)
  await guest.goto('/visit-us/opening-times')
  await expect(guest.getByRole('heading', { level: 1 })).toHaveText('Opening times')
  await guest.goto('/market-day')
  await expect(guest.getByRole('heading', { level: 1 })).toHaveText('Market day')
  await expect(guest.getByText('Stalls from nine.')).toBeVisible()
  await guest.getByRole('link', { name: 'Markets' }).click()
  await expect(guest).toHaveURL('/category/markets')
  await expect(guest.getByRole('heading', { level: 1 })).toHaveText('Markets')
  await expect(guest.getByRole('link', { name: 'Market day' })).toBeVisible()
  // The home page lists the latest posts.
  await guest.goto('/')
  await expect(guest.getByRole('link', { name: 'Market day' })).toBeVisible()
  expect((await guest.goto('/no-such-page'))?.status()).toBe(404)
})

test('drafts show only in preview, and private posts only to those who may read them', async ({
  page,
  browser,
}) => {
  await signInAsAdmin(page)
  await page.goto('/admin/posts/new')
  await page.getByLabel('Add title').fill('Secret plans')
  await page.getByRole('button', { name: 'Save Draft' }).click()
  await notice(page, 'Post draft updated.')
  const preview = (await page.getByRole('link', { name: 'Preview' }).getAttribute('href'))!
  expect(preview).toMatch(/^\/\?preview=[0-9a-f-]{36}$/)
  await page.goto(preview)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Secret plans')
  await expect(page.getByRole('note')).toContainText('visitors can’t see this post')

  const guest = await visitor(browser)
  expect((await guest.goto(preview))?.status()).toBe(404)

  const members = await publish(
    page,
    'posts',
    'Members only',
    () => page.getByRole('radio', { name: 'Private' }).check(),
    'Post published privately.',
  )
  expect((await guest.goto(members!))?.status()).toBe(404)
  await page.goto(members!)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Members only')
})

test('Settings › Reading makes the homepage a page, with the posts on another', async ({
  page,
  browser,
}) => {
  await signInAsAdmin(page)
  await publish(page, 'pages', 'Welcome home')
  await publish(page, 'pages', 'News')
  await page.goto('/admin/settings/reading')
  await page
    .getByLabel('Your homepage displays')
    .selectOption({ label: 'A static page (choose below)' })
  await page.getByLabel('Homepage', { exact: true }).selectOption({ label: 'Welcome home' })
  await page.getByLabel('Posts page').selectOption({ label: 'News' })
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await notice(page, 'Settings saved.')

  const guest = await visitor(browser)
  await guest.goto('/')
  await expect(guest.getByRole('heading', { level: 1 })).toHaveText('Welcome home')
  await guest.goto('/news')
  await expect(guest.getByRole('heading', { level: 1 })).toHaveText('News')
  await expect(guest.getByRole('link', { name: 'Market day' })).toBeVisible()

  // Back to the latest posts, for the specs that follow.
  await page.getByLabel('Your homepage displays').selectOption({ label: 'Your latest posts' })
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await notice(page, 'Settings saved.')
})

test('the site’s pages and the admin, on one server, each keep their own part', async ({
  page,
}) => {
  // Next shares the CMS's modules between them: whichever loaded its site module last must not
  // take the other's templates or admin entries. Back and forth, so one of them always loads last.
  await signInAsAdmin(page)
  for (let round = 0; round < 2; round++) {
    await page.goto('/account')
    await expect(page.getByText('Members’ area')).toBeVisible()
    await page.goto('/admin/library/loans')
    await expect(page.getByRole('heading', { name: 'Loans' })).toBeVisible()
  }
})
