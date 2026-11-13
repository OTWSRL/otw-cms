import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'

export const ADMIN = {
  name: 'Ada Admin',
  email: 'ada@example.com',
  password: 'a strong e2e password',
}
/** The stand-in for `cms serve` the e2e site reports updates through (e2e/fake-supervisor.mjs). */
export const SUPERVISOR = { port: 3199, token: 'e2e-supervisor-token' }

/** Gets the Library fixture's Librarian role in admin.spec.ts. */
export const LIBRARIAN = { email: 'max@example.com', password: 'another e2e password' }

export async function signIn(
  page: Page,
  user: { email: string; password: string },
  path = '/admin',
) {
  await page.goto(path)
  await expect(page).toHaveURL(/\/admin\/login\?next=/)
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Log In' }).click()
}

/** Sets up the administrator when a spec runs on its own, or signs in as them. */
export async function signInAsAdmin(page: Page) {
  await page.goto('/admin/setup')
  if (page.url().endsWith('/admin/setup')) {
    await page.getByLabel('Name').fill(ADMIN.name)
    await page.getByLabel('Email').fill(ADMIN.email)
    await page.getByLabel('Password').fill(ADMIN.password)
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await notice(page, 'Your site is ready.')
    return
  }
  await signIn(page, ADMIN)
  await expect(page).toHaveURL(/\/admin(\?|$)/)
}

/** The one-time message after a form post. */
export function notice(page: Page, message: string | RegExp) {
  return expect(page.getByRole('status').filter({ hasText: message })).toBeVisible()
}

export function mainMenu(page: Page) {
  return page.getByRole('navigation', { name: 'Main menu' })
}

/**
 * A top-level menu entry, which opens its section's first page, as in WordPress. Its name may
 * end in WordPress's update count, as in "Plugins (1 update)".
 */
export async function openSection(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const name = new RegExp(`^${escaped}( \\(\\d+ updates?\\))?$`)
  await mainMenu(page).getByRole('link', { name }).click()
  // The pointer stays where it clicked, over the menu, where another section's flyout can open
  // over the screen's first column, as in WordPress. A person moves away; so does the test.
  await page.waitForLoadState()
  const viewport = page.viewportSize()
  if (viewport) await page.mouse.move(viewport.width - 1, viewport.height - 1)
}

/** The submenu of the current section. Other sections' submenus only fly out on hover. */
export function submenu(page: Page, label: string) {
  return mainMenu(page).getByRole('list', { name: label })
}

// The e2e site's mail plugin writes each email here (MAIL_FILE_DIR in playwright.config.ts).
const MAIL = join(import.meta.dirname, '..', '.data', 'e2e-mail')

export interface Mail {
  to: string[]
  subject: string
  text: string
}

/** The newest email to `to` about `subject`, waiting for it to arrive. */
export async function mailTo(to: string, subject: string): Promise<Mail> {
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
