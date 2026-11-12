import { expect, test, type APIRequestContext } from '@playwright/test'
import { ADMIN, LIBRARIAN, notice, openSection, signIn, SUPERVISOR } from './helpers'

test.describe.configure({ mode: 'serial' })

const asked = async (request: APIRequestContext) =>
  (
    await request.get(`http://127.0.0.1:${SUPERVISOR.port}/plugin-requests`, {
      headers: { authorization: `Bearer ${SUPERVISOR.token}` },
    })
  ).json()

test('Add Plugins lists plugins from npm, searches them, and installs one', async ({
  page,
  request,
}) => {
  await signIn(page, ADMIN)
  await openSection(page, 'Plugins')
  await page.getByRole('link', { name: 'Add Plugin', exact: true }).first().click()
  await expect(page).toHaveURL('/admin/plugins/new')
  await expect(page.getByRole('heading', { name: 'Add Plugins', level: 1 })).toBeVisible()

  // What is on the site already says so; the rest can be installed.
  const forum = page.getByRole('row', { name: /@acme\/forum/ })
  const library = page.getByRole('row', { name: /library-fixture/ })
  await expect(forum).toContainText('Topics and replies for your site.')
  await expect(forum).toContainText('By acme')
  await expect(library).toContainText('Installed')
  await expect(library.getByRole('button', { name: /Install/ })).toHaveCount(0)

  await page.getByLabel('Search plugins').fill('books')
  await page.getByRole('button', { name: 'Search Plugins' }).click()
  await expect(page).toHaveURL(/\?s=books/)
  await expect(forum).toHaveCount(0)
  await expect(library).toHaveCount(1)
  await page.getByLabel('Search plugins').fill('nothing like this')
  await page.getByRole('button', { name: 'Search Plugins' }).click()
  await expect(page.getByText('No plugins found. Try other words')).toBeVisible()

  await page.goto('/admin/plugins/new')
  await forum.hover()
  await forum.getByRole('button', { name: 'Install @acme/forum now' }).click()
  await notice(page, 'Installing @acme/forum. Dashboard › Updates shows the progress.')
  expect(await asked(request)).toEqual([{ install: '@acme/forum' }])

  // The rebuild's steps show on Updates, as an update's do.
  await page.goto('/admin/updates')
  await expect(
    page.getByText('Installed @acme/forum 1.2.0. Activate it on the Plugins screen.'),
  ).toBeVisible({ timeout: 30_000 })
})

test('a plugin is added by its package name, and only a package name', async ({
  page,
  request,
}) => {
  await signIn(page, ADMIN, '/admin/plugins/new')
  await page.getByLabel('Package name').fill('https://example.com/evil.tgz')
  await page.getByRole('button', { name: 'Install Plugin' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Use the plugin’s package name on npm' }),
  ).toBeVisible()

  await page.getByLabel('Package name').fill('@acme/private-wiki')
  await page.getByRole('button', { name: 'Install Plugin' }).click()
  await notice(page, 'Installing @acme/private-wiki.')
  expect(await asked(request)).toContainEqual({ install: '@acme/private-wiki' })
  // One rebuild at a time: this one finishes before the next test asks for another.
  await page.goto('/admin/updates')
  await expect(page.getByText('Installed @acme/private-wiki 1.2.0.')).toBeVisible({
    timeout: 30_000,
  })
})

test('Delete removes an inactive plugin’s data and its package', async ({ page, request }) => {
  await signIn(page, ADMIN, '/admin/plugins')
  const courier = page.getByRole('row', { name: /^Courier/ })
  await courier.getByRole('button', { name: 'Deactivate Courier' }).click()
  await notice(page, 'Courier deactivated.')
  await courier.hover()
  await courier.getByRole('link', { name: 'Delete Courier’s data' }).click()
  await expect(
    page.getByText('You can also remove the plugin itself (courier-fixture)'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete only its data' })).toBeVisible()
  await page.getByRole('button', { name: 'Yes, delete this data and remove the plugin' }).click()
  await notice(page, 'Courier’s data was deleted. Removing courier-fixture.')
  expect(await asked(request)).toContainEqual({ remove: 'courier-fixture' })

  // The stand-in supervisor rebuilds nothing, so the plugin is still here for the other tests.
  await page.goto('/admin/plugins')
  await courier.getByRole('button', { name: 'Activate Courier' }).click()
  await notice(page, 'Courier activated.')
})

test('those who may not install plugins see neither the screen nor the buttons', async ({
  page,
}) => {
  // The Library fixture's librarian, who may use the admin but not manage the site.
  await signIn(page, LIBRARIAN)
  expect((await page.goto('/admin/plugins/new'))?.status()).toBe(403)
})
