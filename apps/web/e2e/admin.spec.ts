import { expect, test } from '@playwright/test'
import { ADMIN, MANAGER, mainMenu, notice, openSection, signIn, submenu } from './helpers'

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
  await signIn(page, ADMIN, '/admin/commerce/orders')
  await expect(page).toHaveURL('/admin/commerce/orders')
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible()
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
  const commerce = page.getByRole('row', { name: /^Commerce/ })
  const stripe = page.getByRole('row', { name: /^Stripe/ })
  await expect(commerce).toHaveClass('active')
  await expect(commerce.getByRole('button', { name: 'Deactivate Commerce' })).toBeDisabled()
  await expect(commerce.getByText('Stripe requires it. Deactivate that first.')).toBeVisible()

  await stripe.getByRole('button', { name: 'Deactivate Stripe' }).click()
  await notice(page, 'Stripe deactivated.')
  await expect(stripe).toHaveClass('inactive')
  await expect(commerce.getByRole('button', { name: 'Deactivate Commerce' })).toBeEnabled()
  await page.getByRole('link', { name: /^Inactive/ }).click()
  await expect(page.getByRole('row', { name: /^(Commerce|Stripe)/ })).toHaveCount(1)

  await stripe.getByRole('button', { name: 'Activate Stripe' }).click()
  await notice(page, 'Stripe activated.')
  // Back on the Inactive view, as WordPress returns to the filter you were on.
  await expect(page).toHaveURL(/plugin_status=inactive/)
  await expect(stripe).toHaveCount(0)
  await page.getByRole('link', { name: /^All/ }).click()
  await expect(stripe).toHaveClass('active')
})

test('products created in the admin go live in the shop', async ({ page }) => {
  await signIn(page, ADMIN)
  await openSection(page, 'Commerce')
  await expect(page).toHaveURL('/admin/commerce/products')
  await page.getByRole('link', { name: 'Add Product' }).click()
  await expect(page).toHaveTitle('Add Product · Admin · My Site')

  await page.getByLabel('Title').fill('Linen Apron')
  await page.getByLabel('Slug').fill('linen-apron')
  await page.getByLabel('Price (USD)').fill('32.5')
  await page.getByLabel('Description').fill('Stonewashed linen.')
  await page.getByRole('button', { name: 'Create product' }).click()

  await notice(page, 'Product created.')
  await expect(page.getByRole('heading', { name: 'Linen Apron' })).toBeVisible()
  await expect(page.getByLabel('Price (USD)')).toHaveValue('32.50')

  await page.getByLabel('Title').fill('Linen Apron, Sand')
  await page.getByRole('button', { name: 'Save product' }).click()
  await notice(page, 'Product saved.')

  await page.getByRole('link', { name: 'View in shop' }).click()
  await expect(page).toHaveURL('/product/linen-apron')
  await expect(page.getByRole('heading', { name: 'Linen Apron, Sand' })).toBeVisible()
  await expect(page.getByText('$32.50')).toBeVisible()
})

test('the product form explains invalid input', async ({ page }) => {
  await signIn(page, ADMIN, '/admin/commerce/products/new')
  await page.getByLabel('Title').fill('Duplicate')
  await page.getByLabel('Slug').fill('ceramic-mug')
  await page.getByLabel('Price (USD)').fill('1')
  await page.getByRole('button', { name: 'Create product' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Another product already uses that slug.' }),
  ).toBeVisible()
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
  await site.getByLabel('Site title').fill('Ada’s Shop')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await notice(page, 'Settings saved.')

  await page.goto('/shop')
  await expect(page.getByRole('link', { name: 'Ada’s Shop' })).toBeVisible()
  await expect(page).toHaveTitle('Shop · Ada’s Shop')

  // Restore the default so the storefront specs see the usual title.
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
  await expect(settings.getByRole('link')).toHaveText(['General', 'Reading', 'Shop', 'Payments'])
  await settings.getByRole('link', { name: 'Payments' }).click()
  await expect(page).toHaveURL('/admin/commerce/settings/payments')
  await expect(page).toHaveTitle('Payment settings · Admin · My Site')
  await expect(settings.getByRole('link', { name: 'Payments' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(settings.getByRole('link', { name: 'Shop' })).not.toHaveAttribute('aria-current')

  // Stripe's section sits on Commerce's page; its keys come from the server environment.
  await expect(page.getByRole('region', { name: 'Stripe' }).getByText('Not set')).toHaveCount(2)

  const payLater = page.getByRole('region', { name: 'Pay later' }).getByLabel('Offer "Pay later"')
  await payLater.uncheck()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await notice(page, 'Settings saved.')
  await page.goto('/product/canvas-tote')
  await expect(page.getByText('Checkout is not available right now.')).toBeVisible()

  await page.goto('/admin/commerce/settings/payments')
  await payLater.check()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await notice(page, 'Settings saved.')
  await page.goto('/product/canvas-tote')
  await expect(page.getByLabel(/Pay later/)).toBeChecked()
})

test('the dashboard shows plugin widgets and notices', async ({ page }) => {
  await signIn(page, ADMIN)
  await expect(page.getByRole('region', { name: 'Orders' })).toContainText(/\d+ awaiting payment/)

  // The e2e server has no Stripe keys, so Stripe says what to set.
  const stripe = page.getByText('Stripe is active, but card payments are off')
  await expect(stripe).toContainText(
    'until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set on the server.',
  )
  await stripe.getByRole('link', { name: 'Payment settings' }).click()
  await expect(page).toHaveURL('/admin/commerce/settings/payments')
})

test('a shop manager confirms a pay-later order but cannot manage plugins', async ({
  page,
  browser,
}) => {
  await signIn(page, ADMIN)
  await openSection(page, 'Users')
  await page.getByRole('link', { name: 'Add User' }).first().click()
  await expect(page).toHaveURL('/admin/users/new')
  await page.getByLabel('Email').fill(MANAGER.email)
  await page.getByLabel('Role').selectOption({ label: 'Shop manager' })
  await page.getByLabel('Password').fill(MANAGER.password)
  await page.getByRole('button', { name: 'Add User' }).click()
  await expect(page).toHaveURL(/\/admin\/users\?flash=/)
  await notice(page, `Added ${MANAGER.email}.`)
  await expect(page.getByRole('row', { name: new RegExp(MANAGER.email) })).toContainText(
    'Shop manager',
  )
  await submenu(page, 'Users').getByRole('link', { name: 'Roles' }).click()
  await expect(page.getByRole('row', { name: /^Shop manager/ })).toContainText(
    'Change shop settings',
  )

  // A shopper places an order in a separate browser session.
  const shopper = await browser.newPage()
  await shopper.goto('/product/field-notebook')
  await shopper.getByLabel('Email').fill('sam@example.com')
  await shopper.getByRole('button', { name: 'Place order' }).click()
  const heading = await shopper.getByRole('heading', { name: /^Order #\d+$/ }).textContent()
  const number = heading!.replace('Order ', '')

  const manager = await browser.newPage()
  await signIn(manager, MANAGER)
  await expect(mainMenu(manager).getByRole('link', { name: 'Plugins' })).toHaveCount(0)
  await openSection(manager, 'Settings')
  await expect(submenu(manager, 'Settings').getByRole('link')).toHaveText(['Shop', 'Payments'])
  // Only people who can change the server's environment are told about missing keys.
  await expect(manager.getByText('Stripe is active')).toHaveCount(0)
  await openSection(manager, 'Commerce')
  await submenu(manager, 'Commerce').getByRole('link', { name: 'Orders' }).click()
  await manager.getByRole('link', { name: number, exact: true }).click()
  await expect(manager.getByTestId('admin-order-status')).toHaveText('Awaiting payment')
  await manager.getByRole('button', { name: 'Mark as paid' }).click()
  await notice(manager, `Order ${number} marked as paid.`)
  await expect(manager.getByTestId('admin-order-status')).toHaveText('Paid')

  await shopper.reload()
  await expect(shopper.getByTestId('order-status')).toHaveText('Paid')

  expect((await manager.goto('/admin/settings'))?.status()).toBe(403)
  const forbidden = await manager.goto('/admin/plugins')
  expect(forbidden?.status()).toBe(403)
  await expect(
    manager.getByRole('heading', { name: 'Sorry, you are not allowed to access this page.' }),
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
