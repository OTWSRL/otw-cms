import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { notice, signInAsAdmin } from './helpers'

// The e2e site's mail plugin writes each email here (MAIL_FILE_DIR in playwright.config.ts).
const MAIL = join(import.meta.dirname, '..', '.data', 'e2e-mail')

test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const CLEO = {
  name: 'Cleo Shopper',
  email: `cleo-${run}@example.com`,
  password: 'a long cleo password',
}

interface Mail {
  to: string[]
  subject: string
  text: string
}

/** The newest email to `to` about `subject`, waiting for it to arrive. */
async function mailTo(to: string, subject: string): Promise<Mail> {
  let found: Mail | null = null
  await expect
    .poll(
      async () => {
        const files = (await readdir(MAIL).catch(() => [] as string[]))
          .filter((name) => name.endsWith('.json'))
          .sort()
          .reverse()
        for (const name of files) {
          const mail = JSON.parse(await readFile(join(MAIL, name), 'utf8')) as Mail
          if (mail.to.includes(to) && mail.subject.endsWith(subject)) return (found = mail)
        }
        return null
      },
      { message: `an email to ${to} about "${subject}"` },
    )
    .toBeTruthy()
  return found!
}

/** The account link in that email, as a path: the browser is on the test's own address. */
async function linkIn(to: string, subject: string): Promise<string> {
  const { text } = await mailTo(to, subject)
  const link = /https?:\/\/\S+\/account\/\S+\?token=[\w-]+/.exec(text)?.[0]
  expect(link, `a link in: ${text}`).toBeTruthy()
  const url = new URL(link!)
  return url.pathname + url.search
}

async function signInOnSite(page: Page, user: { email: string; password: string }) {
  await page.goto('/account')
  const form = page.getByRole('form', { name: 'Sign in' })
  await form.getByLabel('Email address').fill(user.email)
  await form.getByLabel('Password').fill(user.password)
  await form.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
}

test('an administrator opens sign-ups in Settings › General', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/admin/settings')
  await page.getByLabel('Anyone can register').check()
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await notice(page, 'Settings saved.')
  await expect(page.getByLabel('Anyone can register')).toBeChecked()
})

test('a visitor signs up, sets a password from the email, and manages their account', async ({
  page,
}) => {
  await page.goto('/account')
  const register = page.getByRole('form', { name: 'Register' })
  await register.getByLabel('Name').fill(CLEO.name)
  await register.getByLabel('Email address').fill(CLEO.email)
  await register.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('status')).toHaveText(
    'Check your email for a link to set your password.',
  )

  await page.goto(await linkIn(CLEO.email, 'Set your password'))
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible()
  await page.getByLabel('New password').fill(CLEO.password)
  await page.getByRole('button', { name: 'Set password' }).click()
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('Your password is set, and you’re signed in.')
  await expect(page.getByText(`${CLEO.email} (confirmed)`)).toBeVisible()

  const details = page.getByRole('form', { name: 'Your details' })
  await details.getByLabel('Name').fill('Cleo S.')
  await details.getByRole('button', { name: 'Save details' }).click()
  await expect(page.getByRole('status')).toHaveText('Your details were saved.')
  await expect(page.getByText('Signed in as Cleo S.')).toBeVisible()

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('status')).toHaveText('You are signed out.')
  await signInOnSite(page, CLEO)
})

test('a forgotten password is reset from an emailed link, which works once', async ({ page }) => {
  await page.goto('/admin/login')
  await page.getByRole('link', { name: 'Lost your password?' }).click()
  await expect(page).toHaveURL('/account/lost-password')
  await page.getByLabel('Email address').fill(CLEO.email)
  await page.getByRole('button', { name: 'Get a new password' }).click()
  await expect(page.getByRole('status')).toHaveText(
    'If an account uses that address, we’ve emailed it a link to set a new password.',
  )
  const link = await linkIn(CLEO.email, 'Password reset')
  await page.goto(link)
  await page.getByLabel('New password').fill('cleo’s second password')
  await page.getByRole('button', { name: 'Set password' }).click()
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
  CLEO.password = 'cleo’s second password'

  await page.goto(link)
  await expect(page.getByText('This link has expired or has already been used.')).toBeVisible()
})

test('a customer who signs in at the admin lands on their account', async ({ page }) => {
  await page.goto('/admin/login')
  await page.getByLabel('Email Address').fill(CLEO.email)
  await page.getByLabel('Password').fill(CLEO.password)
  await page.getByRole('button', { name: 'Log In' }).click()
  await expect(page).toHaveURL('/account')
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
})

test('an email address changes once the new one confirms it', async ({ page }) => {
  await signInOnSite(page, CLEO)
  const next = `cleo-new-${run}@example.com`
  const change = page.getByRole('form', { name: 'Change email address' })
  await change.getByLabel('New email address').fill(next)
  await change.getByLabel('Current password').fill(CLEO.password)
  await change.getByRole('button', { name: 'Send a confirmation link' }).click()
  await expect(page.getByRole('status')).toContainText(`We’ve emailed ${next} a link`)

  await page.goto(await linkIn(next, 'Confirm your new email address'))
  await expect(page.getByText(`Use ${next} as your account’s email address?`)).toBeVisible()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('status')).toHaveText(`Your email address is now ${next}.`)
  // The old address hears of it, as WordPress tells it.
  expect((await mailTo(CLEO.email, 'Your email address was changed')).text).toContain(next)
  CLEO.email = next
})

test('an account shows the orders placed with its proven address', async ({ page }) => {
  await signInOnSite(page, CLEO)
  const orders = page.getByRole('region', { name: 'Orders' })
  await expect(orders).toContainText('No orders yet.')

  await page.goto('/product/ceramic-mug')
  await page.getByLabel('Email').fill(CLEO.email)
  await page.getByLabel(/Pay later/).check()
  await page.getByRole('button', { name: 'Place order' }).click()
  const number = (await page.getByRole('heading', { name: /^Order #\d+$/ }).textContent())!

  await page.goto('/account')
  await expect(orders.getByRole('link', { name: number.replace('Order ', '') })).toBeVisible()
  await expect(orders).toContainText('Awaiting payment')
})

test('administrators edit their profile, and someone else’s account', async ({ page }) => {
  await signInAsAdmin(page)
  await page.getByRole('button', { name: /^Howdy/ }).click()
  await page.getByRole('link', { name: 'Edit Profile' }).click()
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible()
  await page.getByLabel('Name', { exact: true }).fill('Ada A. Admin')
  await page.getByRole('button', { name: 'Update Profile' }).click()
  await notice(page, 'Profile updated.')
  await expect(page.getByRole('button', { name: 'Howdy, Ada A. Admin' })).toBeVisible()

  await page.goto('/admin/users')
  await page.getByRole('link', { name: `Edit ${CLEO.email}` }).click()
  await expect(page.getByRole('heading', { name: 'Edit User Cleo S.' })).toBeVisible()
  await page.getByRole('button', { name: 'Send Reset Link' }).click()
  await notice(page, `A link to set a new password is on its way to ${CLEO.email}`)
  await mailTo(CLEO.email, 'Password reset')
})
