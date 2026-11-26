import { expect, test, type Page } from '@playwright/test'
import { APP_CODE } from '../fixtures/courier/index'
import { ADMIN, signInAsAdmin } from './helpers'

// The Courier fixture adds a sign-in provider whose "service" is a page of its own: it asks for
// an address and sends the browser back with it. It hosts example.com's mailboxes only.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const NEW = `courier-new-${run}@example.com`
const TWO_STEP = `twostep-courier-${run}@example.com`

/** The pretend service's page: says who you are, and allows it. */
async function allowAs(page: Page, email: string) {
  await expect(page.getByRole('heading', { name: 'Courier' })).toBeVisible()
  await page.getByLabel('Your Courier address').fill(email)
  await page.getByRole('button', { name: 'Allow' }).click()
}

const error = (page: Page, message: string) =>
  expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible()

test('the admin’s sign-in page offers the provider, and its owner’s address opens their account', async ({
  page,
  context,
}) => {
  await signInAsAdmin(page)
  await context.clearCookies()

  const login = await page.goto('/admin/plugins')
  await expect(page).toHaveURL(/\/admin\/login\?next=/)
  const button = page.getByRole('link', { name: 'Continue with Courier' })
  // Its mark comes from an address the browser keeps, not written into every sign-in page.
  expect(await login!.text()).not.toContain('data:image')
  const mark = button.locator('img')
  await expect(mark).toHaveAttribute(
    'src',
    /^\/api\/p\/core\/sign-in\/courier\/image\?v=[0-9a-f]{12}$/,
  )
  // Drawn: the browser fetched it.
  await expect
    .poll(() => mark.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true)
  const image = await page.request.get((await mark.getAttribute('src'))!)
  expect(image.headers()['content-type']).toBe('image/svg+xml')
  expect(image.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
  // A plain link, with no script behind it.
  await expect(button).toHaveAttribute(
    'href',
    '/api/p/core/sign-in/courier?screen=admin&next=%2Fadmin%2Fplugins',
  )
  await button.click()
  await allowAs(page, ADMIN.email)
  // Where they were headed, signed in as the account that has the address.
  await expect(page).toHaveURL('/admin/plugins')
  await expect(page.getByText(`Howdy, ${ADMIN.name}`)).toBeVisible()
})

test('someone new gets an account from the account page, and is signed in', async ({ page }) => {
  await page.goto('/account')
  await page.getByRole('link', { name: 'Continue with Courier' }).click()
  await allowAs(page, NEW)
  await expect(page).toHaveURL('/account')
  await expect(page.getByText(NEW).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
})

test('cancelling at the provider says so and signs nobody in', async ({ page }) => {
  await page.goto('/account')
  await page.getByRole('link', { name: 'Continue with Courier' }).click()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page).toHaveURL(/\/account\?flash=/)
  await error(page, 'You didn’t allow it at Courier.')
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
})

test('an address the provider doesn’t host can’t open the account that has it', async ({
  page,
  browser,
}) => {
  // An account with an address at another host, made the ordinary way by an administrator.
  const admin = await browser.newContext()
  const adminPage = await admin.newPage()
  await signInAsAdmin(adminPage)
  const elsewhere = `courier-${run}@elsewhere.test`
  await adminPage.goto('/admin/users/new')
  await adminPage.getByLabel('Email').fill(elsewhere)
  await adminPage.getByLabel('Password').fill('a long password for elsewhere')
  await adminPage.getByRole('button', { name: 'Add User' }).click()
  await admin.close()

  await page.goto('/admin/login')
  await page.getByRole('link', { name: 'Continue with Courier' }).click()
  await allowAs(page, elsewhere)
  await expect(page).toHaveURL(/\/admin\/login\?flash=/)
  await error(page, `An account here already uses ${elsewhere}. Sign in with its password.`)
})

test('a sign-in step still asks for its code afterwards', async ({ page }) => {
  await page.goto('/account')
  await page.getByRole('link', { name: 'Continue with Courier' }).click()
  await allowAs(page, TWO_STEP)
  await expect(page).toHaveURL('/account/verify')
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
  await page.getByLabel('Code').fill(APP_CODE)
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).toHaveURL('/account')
  await expect(page.getByText(TWO_STEP).first()).toBeVisible()
})

test('a way back that this browser didn’t leave by is refused', async ({ page }) => {
  await page.goto(
    '/api/p/core/sign-in/courier/callback?state=x&code=' + encodeURIComponent(ADMIN.email),
  )
  await expect(page).toHaveURL(/\/admin\/login\?flash=/)
  await error(page, 'That sign-in has run out. Try again.')
})
