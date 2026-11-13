import { expect, test } from '@playwright/test'
import { notice, signInAsAdmin } from './helpers'

// The Library fixture's Overdue notices section has one of each kind of settings field that
// isn't a plain input: role checkboxes, fields that show only for a choice, rows of pairs, and
// a box of several lines.
test.describe.configure({ mode: 'serial' })

const SETTINGS = '/admin/library/settings'

test('fields show only for the choice they belong to, as the form is changed', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto(SETTINGS)
  const url = page.getByLabel('Webhook URL')
  const headers = page.getByRole('group', { name: 'Headers' })
  await expect(page.getByLabel('Send notices through')).toHaveValue('none')
  await expect(url).toBeHidden()
  await expect(page.getByLabel('Authorization')).toBeHidden()
  await expect(headers).toBeHidden()

  // Chosen, not yet saved: its fields are there.
  await page.getByLabel('Send notices through').selectOption('webhook')
  await expect(url).toBeVisible()
  await expect(page.getByLabel('Authorization')).toBeVisible()
  await expect(page.getByLabel('Notice', { exact: true })).toBeVisible()
  // The headers need a second choice as well.
  await expect(headers).toBeHidden()
  await page.getByLabel('Authorization').selectOption('headers')
  await expect(headers).toBeVisible()

  await page.getByLabel('Send notices through').selectOption('none')
  await expect(url).toBeHidden()
  await expect(headers).toBeHidden()
})

test('roles are ticked from the site’s own, plugins’ included, and rows are added and removed', async ({
  page,
}) => {
  await signInAsAdmin(page)
  await page.goto(SETTINGS)
  const roles = page.getByRole('group', { name: 'Tell these roles' })
  await expect(roles.getByLabel('Administrator')).not.toBeChecked()
  await roles.getByLabel('Editor').check()
  // A role the Library plugin adds.
  await roles.getByLabel('Librarian').check()

  await page.getByLabel('Send notices through').selectOption('webhook')
  await page.getByLabel('Webhook URL').fill('https://hooks.example.com/overdue')
  await page.getByLabel('Authorization').selectOption('headers')
  const headers = page.getByRole('group', { name: 'Headers' })
  await headers.getByRole('textbox', { name: 'Header' }).first().fill('X-Api-Key')
  await headers.getByRole('textbox', { name: 'Value' }).first().fill('env:LIBRARY_KEY')
  await headers.getByRole('button', { name: 'Add Row' }).click()
  await headers.getByRole('textbox', { name: 'Header' }).nth(1).fill('X-Mistake')
  await headers.getByRole('textbox', { name: 'Value' }).nth(1).fill('oops')
  await headers.getByRole('button', { name: 'Add Row' }).click()
  await headers.getByRole('textbox', { name: 'Header' }).nth(2).fill('X-Library')
  await headers.getByRole('textbox', { name: 'Value' }).nth(2).fill('Main Street')
  await headers.getByRole('button', { name: 'Remove X-Mistake' }).click()
  await expect(headers.getByRole('textbox', { name: 'Header' })).toHaveCount(2)
  await page.getByLabel('Notice', { exact: true }).fill('Dear reader,\nyour book is overdue.')

  await page.getByRole('button', { name: 'Save Changes' }).click()
  await notice(page, 'Settings saved.')

  // Saved, and shown as it was left: the webhook's fields are there without choosing again.
  await expect(roles.getByLabel('Editor')).toBeChecked()
  await expect(roles.getByLabel('Librarian')).toBeChecked()
  await expect(roles.getByLabel('Administrator')).not.toBeChecked()
  await expect(page.getByLabel('Webhook URL')).toHaveValue('https://hooks.example.com/overdue')
  await expect(headers).toBeVisible()
  const names = headers.getByRole('textbox', { name: 'Header' })
  // The two saved rows, and one waiting to be filled in.
  await expect(names).toHaveCount(3)
  await expect(names.nth(0)).toHaveValue('X-Api-Key')
  await expect(names.nth(1)).toHaveValue('X-Library')
  await expect(headers.getByRole('textbox', { name: 'Value' }).nth(1)).toHaveValue('Main Street')
  await expect(page.getByLabel('Notice', { exact: true })).toHaveValue(
    'Dear reader,\nyour book is overdue.',
  )
  await expect(page.getByRole('link', { name: 'See the books' })).toHaveAttribute(
    'href',
    '/admin/library/books',
  )
})

test('a field that is hidden keeps its value', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto(SETTINGS)
  await page.getByLabel('Send notices through').selectOption('none')
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await notice(page, 'Settings saved.')
  await expect(page.getByLabel('Webhook URL')).toBeHidden()

  await page.getByLabel('Send notices through').selectOption('webhook')
  await expect(page.getByLabel('Webhook URL')).toHaveValue('https://hooks.example.com/overdue')
  await expect(
    page.getByRole('group', { name: 'Headers' }).getByRole('textbox', { name: 'Header' }).first(),
  ).toHaveValue('X-Api-Key')
})

test('a row that is wrong is refused, and nothing is saved', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto(SETTINGS)
  await page.getByLabel('Send notices through').selectOption('webhook')
  const headers = page.getByRole('group', { name: 'Headers' })
  // A value with no name beside it.
  await headers.getByRole('textbox', { name: 'Value' }).last().fill('orphan')
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Headers: Give "orphan" a name, or remove its row.' }),
  ).toBeVisible()
})
