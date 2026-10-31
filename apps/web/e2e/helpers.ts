import { expect, type Page } from '@playwright/test'

export const ADMIN = {
  name: 'Ada Admin',
  email: 'ada@example.com',
  password: 'a strong e2e password',
}
export const MANAGER = { email: 'max@example.com', password: 'another e2e password' }

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

/** The one-time message after a form post. */
export function notice(page: Page, message: string) {
  return expect(page.getByRole('status').filter({ hasText: message })).toBeVisible()
}

export function mainMenu(page: Page) {
  return page.getByRole('navigation', { name: 'Main menu' })
}

/** A top-level menu entry, which opens its section's first page, as in WordPress. */
export function openSection(page: Page, label: string) {
  return mainMenu(page).getByRole('link', { name: label, exact: true }).click()
}

/** The submenu of the current section. Other sections' submenus only fly out on hover. */
export function submenu(page: Page, label: string) {
  return mainMenu(page).getByRole('list', { name: label })
}
