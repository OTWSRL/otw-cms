import { expect, test, type Page } from '@playwright/test'
import { APP_CODE, EMAIL_CODE } from '../fixtures/courier/index'
import { ADMIN, mailTo, notice, openSection, signIn, signInAsAdmin } from './helpers'

// The Courier fixture adds a sign-in step for addresses that start with `twostep`: a fixed code
// from their "app", or one it emails.
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const TESS = { email: `twostep-${run}@example.com`, password: 'a long two-step password' }

const error = (page: Page, message: string) =>
  expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible()

test('an administrator adds someone the step asks for a code', async ({ page }) => {
  await signInAsAdmin(page)
  await openSection(page, 'Users')
  await page.getByRole('link', { name: 'Add User' }).first().click()
  await page.getByLabel('Email').fill(TESS.email)
  await page.getByLabel('Role').selectOption({ label: 'Administrator' })
  await page.getByLabel('Password').fill(TESS.password)
  await page.getByRole('button', { name: 'Add User' }).click()
  await notice(page, `Added ${TESS.email}.`)
})

test('the admin asks for a code after the password, and signs in once one passes', async ({
  page,
}) => {
  await signIn(page, TESS, '/admin/plugins')
  await expect(page).toHaveURL('/admin/login/verify')
  await expect(page).toHaveTitle('Verify it’s you · My Site')
  await expect(page.getByRole('heading', { name: 'Verify it’s you' })).toBeVisible()
  await expect(page.getByText('Enter the 6-digit code from your authenticator app.')).toBeVisible()
  const code = page.getByLabel('Code')
  await expect(code).toBeFocused()
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code')
  await expect(code).toHaveAttribute('inputmode', 'numeric')

  // Not signed in yet: the admin still sends them to log in.
  const other = await page.context().newPage()
  await other.goto('/admin/plugins')
  await expect(other).toHaveURL(/\/admin\/login\?next=/)
  await other.close()

  await code.fill('000000')
  await page.getByRole('button', { name: 'Verify' }).click()
  await error(page, 'That code isn’t right.')
  await expect(page).toHaveURL(/\/admin\/login\/verify\?flash=/)

  // Another way: a code by email, which only a button sends.
  await page.getByRole('button', { name: 'Email me a code' }).click()
  await notice(page, 'A new code is on its way.')
  await expect(page).toHaveURL(/\/admin\/login\/verify\?method=email/)
  await expect(page.getByText(`Enter the code we emailed to ${TESS.email}.`)).toBeVisible()
  expect((await mailTo(TESS.email, 'Your sign-in code')).text).toContain(EMAIL_CODE)
  await expect(page.getByRole('button', { name: 'Send a new code' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Authenticator app' })).toBeVisible()

  await page.getByLabel('Code').fill(EMAIL_CODE)
  await page.getByLabel('Don’t ask again on this device for 30 days').check()
  await page.getByRole('button', { name: 'Verify' }).click()
  // On to where they were headed.
  await expect(page).toHaveURL('/admin/plugins')
  await expect(page.getByRole('heading', { name: 'Plugins', level: 1 })).toBeVisible()

  // This browser is remembered: signed out and in again, no code is asked for.
  await page.getByRole('button', { name: /^Howdy, / }).click()
  await page.getByRole('button', { name: 'Log Out' }).click()
  await notice(page, 'You are signed out.')
  await signIn(page, TESS, '/admin/plugins')
  await expect(page).toHaveURL('/admin/plugins')
})

test('a browser that wasn’t remembered is asked again, here on the site’s account page', async ({
  page,
}) => {
  await page.goto('/account?next=/account/lost-password')
  const form = page.getByRole('form', { name: 'Sign in' })
  await form.getByLabel('Email address').fill(TESS.email)
  await form.getByLabel('Password').fill(TESS.password)
  await form.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/account/verify')
  await expect(page).toHaveTitle(/Verify it’s you/)
  await expect(page.getByRole('heading', { name: 'Verify it’s you' })).toBeVisible()
  await expect(page.getByText('Enter the 6-digit code from your authenticator app.')).toBeVisible()

  await page.getByRole('button', { name: 'Use another way: Email me a code' }).click()
  await expect(page).toHaveURL(/\/account\/verify\?method=email/)
  await expect(page.getByRole('status')).toHaveText('A new code is on its way.')
  await page.getByRole('link', { name: 'Use another way: Authenticator app' }).click()
  await expect(page).toHaveURL('/account/verify?method=app')

  await page.getByLabel('Code').fill(APP_CODE)
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).toHaveURL('/account/lost-password')
  await page.goto('/account')
  await expect(page.getByText(`Signed in as ${TESS.email}`)).toBeVisible()
})

test('the code screens say when there is no sign-in to finish', async ({ page }) => {
  await page.goto('/admin/login/verify')
  await expect(page.getByRole('heading', { name: 'That sign-in has run out' })).toBeVisible()
  await page.getByRole('link', { name: '← Back to log in' }).click()
  await expect(page).toHaveURL('/admin/login')

  await page.goto('/account/verify')
  await expect(page.getByRole('heading', { name: 'That sign-in has run out' })).toBeVisible()
  await page.getByRole('link', { name: 'Sign in again' }).click()
  await expect(page).toHaveURL('/account')
})

test('someone the step has no way to ask signs in with the password alone', async ({ page }) => {
  await signIn(page, ADMIN)
  await expect(page).toHaveURL(/\/admin(\?|$)/)
})

test('plugins add sections to the Profile and Edit User screens', async ({ page }) => {
  await signIn(page, ADMIN, '/admin/profile')
  await expect(page.getByRole('heading', { name: 'Deliveries' })).toBeVisible()
  await expect(page.getByText(`Courier delivers to ${ADMIN.email}.`)).toBeVisible()

  await openSection(page, 'Users')
  await page.getByRole('link', { name: TESS.email }).first().click()
  await expect(
    page.getByText(`${ADMIN.email} can see that Courier delivers to ${TESS.email}.`),
  ).toBeVisible()
})
