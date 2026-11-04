import { expect, test } from '@playwright/test'
import { ADMIN, LIBRARIAN, SUPERVISOR, mainMenu, notice, signIn, submenu } from './helpers'

// The site reports updates through e2e/fake-supervisor.mjs, standing in for `cms serve`: OTW CMS
// 0.1.3 and the Library 0.1.5 are waiting, and the Library 1.0.0 is held back for Courier.
test.describe.configure({ mode: 'serial' })

const LIBRARY = 'library-fixture'

test('administrators see waiting updates in the menu and on the Plugins screen', async ({
  page,
}) => {
  await signIn(page, ADMIN)
  await expect(mainMenu(page).getByRole('link', { name: 'Dashboard (2 updates)' })).toBeVisible()
  await expect(mainMenu(page).getByRole('link', { name: 'Plugins (1 update)' })).toBeVisible()

  await page.goto('/admin/plugins')
  const library = page.getByRole('row', { name: /^Library/ })
  await expect(library).toContainText('There is a new version of Library available: 0.1.5.')
  await expect(library.getByRole('button', { name: 'Update now Library' })).toBeVisible()
  await expect(page.getByRole('row', { name: /^Courier/ })).not.toContainText('new version')
})

test('the Updates screen lists core and plugin updates, and why one waits', async ({ page }) => {
  await signIn(page, ADMIN)
  await mainMenu(page).getByRole('link', { name: 'Dashboard (2 updates)' }).click()
  await submenu(page, 'Dashboard').getByRole('link', { name: 'Updates (2 updates)' }).click()
  await expect(page).toHaveURL('/admin/updates')
  await expect(page).toHaveTitle('Updates · Admin · My Site')

  await expect(page.getByText('Last checked on 2026-11-01 06:00 UTC.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Update to version 0.1.3' })).toBeVisible()
  const row = page
    .getByRole('table', { name: 'Plugins with updates' })
    .getByRole('row', { name: new RegExp(LIBRARY) })
  await expect(row).toContainText('You have version 0.1.0 installed. Update to 0.1.5.')
  await expect(row).toContainText('Compatibility with OTW CMS 0.1.3: Yes (according to its author)')
  await expect(row).toContainText(
    '1.0.0 is out, but courier-fixture 0.1.0 needs library-fixture ^0.1.0.',
  )

  await page.getByRole('button', { name: 'Check again' }).click()
  await notice(page, '1 update(s) available.')
})

test('updating ticked plugins shows each step until it’s done', async ({ page, request }) => {
  await signIn(page, ADMIN, '/admin/updates')
  await page.getByRole('checkbox', { name: `Select ${LIBRARY}` }).check()
  await page.getByRole('button', { name: 'Update Plugins' }).click()
  await notice(page, 'Updating. This page shows the progress.')
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Build the new release' }),
  ).toBeVisible()
  // The screen refreshes itself while the job runs.
  await expect(page.getByText(`Updated: ${LIBRARY}.`)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('listitem').filter({ hasText: 'Switch' })).toContainText('(done)')

  const asked = await request.get(`http://127.0.0.1:${SUPERVISOR.port}/requests`, {
    headers: { authorization: `Bearer ${SUPERVISOR.token}` },
  })
  expect(await asked.json()).toEqual([{ packages: [LIBRARY] }])
})

test('automatic updates are saved, and a previous release can be restored', async ({ page }) => {
  await signIn(page, ADMIN, '/admin/updates')
  await page.getByRole('radio', { name: /^Patch releases/ }).check()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await notice(page, 'Patch releases of core and plugins will be installed automatically.')
  await expect(page.getByRole('radio', { name: /^Patch releases/ })).toBeChecked()

  const previous = page.getByRole('row', { name: /2026-10-30 09:00 UTC/ })
  await expect(previous).toContainText('Previous')
  // Row actions appear on hover, as in WordPress's list tables.
  await previous.hover()
  await previous.getByRole('button', { name: 'Roll back to this release' }).click()
  await notice(page, 'Going back to the release from 2026-10-30 09:00.')
  await expect(page.getByText('Rolled back.')).toBeVisible({ timeout: 30_000 })
})

test('people who may not update don’t see updates at all', async ({ page }) => {
  await signIn(page, LIBRARIAN)
  await expect(mainMenu(page).getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible()
  await expect(mainMenu(page).getByRole('link', { name: /updates?\)/ })).toHaveCount(0)
  expect((await page.goto('/admin/updates'))?.status()).toBe(403)
  await page.goto('/admin/library/loans')
  await expect(page.getByText('There is a new version')).toHaveCount(0)
})
