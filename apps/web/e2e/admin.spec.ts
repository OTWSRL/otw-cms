import { expect, test } from '@playwright/test'
import { ADMIN, LIBRARIAN, mainMenu, notice, openSection, signIn, submenu } from './helpers'

// One site, set up by the first test; the rest build on it.
test.describe.configure({ mode: 'serial' })

test('the first visit sets up the administrator', async ({ page }) => {
  await page.goto('/admin')
  await expect(page).toHaveURL('/admin/setup')
  await page.getByLabel('Name').fill(ADMIN.name)
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Create administrator' }).click()

  await expect(page).toHaveURL(/\/admin\?flash=/)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await notice(page, 'Your site is ready.')
  await expect(page).toHaveTitle('Dashboard · Admin · My Site')
  // cms.config.json gives no brand, so the admin goes by the CMS's own name.
  await expect(page.getByRole('contentinfo')).toContainText('Thank you for creating with OTW CMS.')

  // Setup is closed now.
  await page.goto('/admin/setup')
  await expect(page).toHaveURL('/admin')
})

test('signed-out visitors sign in and land where they were going', async ({ page }) => {
  await signIn(page, ADMIN, '/admin/library/loans')
  await expect(page).toHaveURL('/admin/library/loans')
  await expect(page.getByRole('heading', { name: 'Loans' })).toBeVisible()
})

test('a wrong password is explained on the form', async ({ page }) => {
  await signIn(page, { email: ADMIN.email, password: 'not the password' })
  // Filtered: Next's route announcer is an alert too.
  await expect(
    page.getByRole('alert').filter({ hasText: 'Incorrect email or password.' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Log In' })).toBeVisible()
})

test('plugins deactivate and reactivate in dependency order', async ({ page }) => {
  await signIn(page, ADMIN)
  await openSection(page, 'Plugins')
  await expect(page).toHaveURL('/admin/plugins')

  // Rows are named by their first cell, the plugin's name.
  const library = page.getByRole('row', { name: /^Library/ })
  const courier = page.getByRole('row', { name: /^Courier/ })
  await expect(library).toHaveClass('active')
  await expect(library.getByRole('button', { name: 'Deactivate Library' })).toBeDisabled()
  await expect(library.getByText('Courier requires it. Deactivate that first.')).toBeVisible()

  await courier.getByRole('button', { name: 'Deactivate Courier' }).click()
  await notice(page, 'Courier deactivated.')
  await expect(courier).toHaveClass('inactive')
  await expect(library.getByRole('button', { name: 'Deactivate Library' })).toBeEnabled()
  await page.getByRole('link', { name: /^Inactive/ }).click()
  await expect(page.getByRole('row', { name: /^(Library|Courier)/ })).toHaveCount(1)

  await courier.getByRole('button', { name: 'Activate Courier' }).click()
  await notice(page, 'Courier activated.')
  // Back on the Inactive view, as WordPress returns to the filter you were on.
  await expect(page).toHaveURL(/plugin_status=inactive/)
  await expect(courier).toHaveCount(0)
  await page.getByRole('link', { name: /^All/ }).click()
  await expect(courier).toHaveClass('active')
})

test('an inactive plugin’s data is deleted after a confirmation, and it starts again from nothing', async ({
  page,
}) => {
  await signIn(page, ADMIN)
  await page.goto('/admin/plugins')
  const library = page.getByRole('row', { name: /^Library/ })
  const courier = page.getByRole('row', { name: /^Courier/ })
  // Only an inactive plugin offers it, as WordPress offers Delete.
  await expect(library.getByRole('link', { name: 'Delete Library’s data' })).toHaveCount(0)
  await courier.getByRole('button', { name: 'Deactivate Courier' }).click()
  await notice(page, 'Courier deactivated.')
  await library.getByRole('button', { name: 'Deactivate Library' }).click()
  await notice(page, 'Library deactivated.')

  await library.hover()
  await library.getByRole('link', { name: 'Delete Library’s data' }).click()
  await expect(page.getByRole('heading', { name: 'Delete Library’s data', level: 1 })).toBeVisible()
  await expect(page.getByText('What Library stored itself, such as its tables.')).toBeVisible()
  // Changed their mind: nothing happens.
  await page.getByRole('link', { name: 'No, return me to the plugin list' }).click()
  await expect(page).toHaveURL('/admin/plugins')

  await library.hover()
  await library.getByRole('link', { name: 'Delete Library’s data' }).click()
  await page.getByRole('button', { name: 'Yes, delete this data' }).click()
  await notice(page, 'Library’s data was deleted.')
  await expect(page).toHaveURL(/\/admin\/plugins/)
  await expect(library).toHaveClass('inactive')

  // Activated again, it makes its table again, and the plugin that needs it can come back.
  await library.getByRole('button', { name: 'Activate Library' }).click()
  await notice(page, 'Library activated.')
  await courier.getByRole('button', { name: 'Activate Courier' }).click()
  await notice(page, 'Courier activated.')
  expect((await page.goto('/library'))?.status()).toBe(200)
})

test('settings saved in the admin change the site', async ({ page }) => {
  await signIn(page, ADMIN)
  await openSection(page, 'Settings')
  await expect(page).toHaveURL('/admin/settings')
  await expect(submenu(page, 'Settings').getByRole('link', { name: 'General' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page).toHaveTitle('General settings · Admin · My Site')

  const site = page.getByRole('region', { name: 'Site' })
  await site.getByLabel('Site title').fill('Ada’s Library')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await notice(page, 'Settings saved.')

  await page.goto('/library')
  await expect(page.getByRole('link', { name: 'Ada’s Library' })).toBeVisible()
  await expect(page).toHaveTitle('Library · Ada’s Library')

  // Restore the default so the other specs see the usual title.
  await page.goto('/admin/settings')
  await site.getByLabel('Site title').fill('')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await notice(page, 'Settings saved.')
  await expect(site.getByLabel('Site title')).toHaveValue('My Site')
})

test('plugins add pages under Settings and sections to each other’s pages', async ({ page }) => {
  await signIn(page, ADMIN)
  await openSection(page, 'Settings')
  const settings = submenu(page, 'Settings')
  await expect(settings.getByRole('link')).toHaveText([
    'General',
    'Reading',
    'Media',
    'Webhooks',
    'Library',
    'Mail to files',
  ])
  await settings.getByRole('link', { name: 'Library' }).click()
  await expect(page).toHaveURL('/admin/library/settings')
  await expect(page).toHaveTitle('Library settings · Admin · My Site')
  await expect(settings.getByRole('link', { name: 'Library' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(settings.getByRole('link', { name: 'General' })).not.toHaveAttribute('aria-current')

  // Courier's section sits on the Library's page; its key comes from the server environment.
  await expect(page.getByRole('region', { name: 'Courier' }).getByText('Not set')).toHaveCount(1)

  const open = page
    .getByRole('region', { name: 'Reading room' })
    .getByLabel('Open the reading room')
  await open.uncheck()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await notice(page, 'Settings saved.')
  await page.goto('/library')
  await expect(page.getByText('The reading room is closed.')).toBeVisible()

  await page.goto('/admin/library/settings')
  await open.check()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await notice(page, 'Settings saved.')
  await page.goto('/library')
  await expect(page.getByRole('link', { name: 'Middlemarch' })).toBeVisible()
})

test('the dashboard shows plugin widgets and notices', async ({ page }) => {
  await signIn(page, ADMIN)
  await expect(page.getByRole('region', { name: 'Loans' })).toContainText('2 books on loan')

  // The e2e server has no Courier key, so Courier says what to set.
  const courier = page.getByText('Courier is active, but deliveries are off')
  await expect(courier).toContainText('until COURIER_API_KEY is set on the server.')
  await courier.getByRole('link', { name: 'Library settings' }).click()
  await expect(page).toHaveURL('/admin/library/settings')
})

test('a plugin’s role reaches its own screens but not the site’s settings or plugins', async ({
  page,
  browser,
}) => {
  await signIn(page, ADMIN)
  await openSection(page, 'Users')
  await page.getByRole('link', { name: 'Add User' }).first().click()
  await expect(page).toHaveURL('/admin/users/new')
  await page.getByLabel('Email').fill(LIBRARIAN.email)
  await page.getByLabel('Role').selectOption({ label: 'Librarian' })
  await page.getByLabel('Password').fill(LIBRARIAN.password)
  await page.getByRole('button', { name: 'Add User' }).click()
  await expect(page).toHaveURL(/\/admin\/users\?flash=/)
  await notice(page, `Added ${LIBRARIAN.email}.`)
  await expect(page.getByRole('row', { name: new RegExp(LIBRARIAN.email) })).toContainText(
    'Librarian',
  )
  await submenu(page, 'Users').getByRole('link', { name: 'Roles' }).click()
  await expect(page.getByRole('row', { name: /^Librarian/ })).toContainText(
    'Change library settings',
  )

  const librarian = await browser.newPage()
  await signIn(librarian, LIBRARIAN)
  await expect(mainMenu(librarian).getByRole('link', { name: 'Plugins' })).toHaveCount(0)
  // Library settings is the only settings page a librarian may open, so Settings goes straight
  // to it, without a submenu, as WordPress shows none for a single page.
  await openSection(librarian, 'Settings')
  await expect(librarian).toHaveURL('/admin/library/settings')
  await expect(submenu(librarian, 'Settings')).toHaveCount(0)
  // Only people who can change the server's environment are told about missing keys.
  await expect(librarian.getByText('Courier is active')).toHaveCount(0)
  await openSection(librarian, 'Library')
  await submenu(librarian, 'Library').getByRole('link', { name: 'Books' }).click()
  await expect(librarian.getByRole('row', { name: /^Middlemarch/ })).toContainText('George Eliot')

  expect((await librarian.goto('/admin/settings'))?.status()).toBe(403)
  const forbidden = await librarian.goto('/admin/plugins')
  expect(forbidden?.status()).toBe(403)
  await expect(
    librarian.getByRole('heading', { name: 'Sorry, you are not allowed to access this page.' }),
  ).toBeVisible()
})

test('signing out ends the session', async ({ page }) => {
  await signIn(page, ADMIN)
  await page.getByRole('button', { name: /^Howdy, Ada Admin/ }).click()
  await page.getByRole('button', { name: 'Log Out' }).click()
  await notice(page, 'You are signed out.')
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin$/)
})

test('admin forms reject cross-site posts', async ({ request }) => {
  const response = await request.post('/api/p/core/actions/create-user', {
    headers: { origin: 'https://evil.test' },
    form: { email: 'evil@evil.test', role: 'administrator', password: 'whatever whatever' },
  })
  expect(response.status()).toBe(403)
})
