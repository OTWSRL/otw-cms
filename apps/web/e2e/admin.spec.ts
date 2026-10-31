import { expect, test, type Page } from '@playwright/test'

// One site, set up by the first test; the rest build on it.
test.describe.configure({ mode: 'serial' })

const ADMIN = { name: 'Ada Admin', email: 'ada@example.com', password: 'a strong e2e password' }
const MANAGER = { email: 'max@example.com', password: 'another e2e password' }

async function signIn(page: Page, user: { email: string; password: string }, path = '/admin') {
  await page.goto(path)
  await expect(page).toHaveURL(/\/admin\/login\?next=/)
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

function notice(page: Page, message: string) {
  return expect(page.getByRole('status').filter({ hasText: message })).toBeVisible()
}

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
  await expect(page).toHaveTitle('Dashboard · Admin · Next CMS')

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
  await expect(page.getByText('Incorrect email or password.')).toHaveAttribute('role', 'alert')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})

test('plugins deactivate and reactivate in dependency order', async ({ page }) => {
  await signIn(page, ADMIN)
  await page
    .getByRole('navigation', { name: 'Admin' })
    .getByRole('link', { name: 'Plugins' })
    .click()
  await expect(page).toHaveURL('/admin/plugins')

  const commerce = page.getByTestId('plugin-commerce')
  await expect(commerce.getByRole('button', { name: 'Deactivate Commerce' })).toBeDisabled()
  await expect(commerce.getByText('Stripe requires it. Deactivate that first.')).toBeVisible()

  const stripe = page.getByTestId('plugin-commerce-stripe')
  await stripe.getByRole('button', { name: 'Deactivate Stripe' }).click()
  await notice(page, 'Stripe deactivated.')
  await expect(stripe.getByRole('cell', { name: 'Inactive' })).toBeVisible()
  await expect(commerce.getByRole('button', { name: 'Deactivate Commerce' })).toBeEnabled()

  await stripe.getByRole('button', { name: 'Activate Stripe' }).click()
  await notice(page, 'Stripe activated.')
  await expect(stripe.getByRole('cell', { name: 'Active', exact: true })).toBeVisible()
})

test('products created in the admin go live in the shop', async ({ page }) => {
  await signIn(page, ADMIN)
  await page
    .getByRole('navigation', { name: 'Admin' })
    .getByRole('link', { name: 'Products' })
    .click()
  await page.getByRole('link', { name: 'Add product' }).click()
  await expect(page).toHaveTitle('Add product · Admin · Next CMS')

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
  await expect(page.getByText('Another product already uses that slug.')).toHaveAttribute(
    'role',
    'alert',
  )
})

test('settings saved in the admin change the site', async ({ page }) => {
  await signIn(page, ADMIN)
  await page
    .getByRole('navigation', { name: 'Admin' })
    .getByRole('link', { name: 'Settings' })
    .click()

  const general = page.getByRole('region', { name: 'General' })
  await general.getByLabel('Site title').fill('Ada’s Shop')
  await general.getByRole('button', { name: 'Save General settings' }).click()
  await notice(page, 'Settings saved.')

  await page.goto('/shop')
  await expect(page.getByRole('link', { name: 'Ada’s Shop' })).toBeVisible()
  await expect(page).toHaveTitle('Shop · Ada’s Shop')

  // Restore the default so the storefront specs see the usual title.
  await page.goto('/admin/settings')
  await general.getByLabel('Site title').fill('')
  await general.getByRole('button', { name: 'Save General settings' }).click()
  await notice(page, 'Settings saved.')
  await expect(general.getByLabel('Site title')).toHaveValue('Next CMS')
})

test('a shop manager confirms a pay-later order but cannot manage plugins', async ({
  page,
  browser,
}) => {
  await signIn(page, ADMIN)
  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Users' }).click()
  const addUser = page.getByRole('region', { name: 'Add user' })
  await addUser.getByLabel('Email').fill(MANAGER.email)
  await addUser.getByLabel('Role').selectOption({ label: 'Shop manager' })
  await addUser.getByLabel('Password').fill(MANAGER.password)
  await addUser.getByRole('button', { name: 'Add user' }).click()
  await notice(page, `Added ${MANAGER.email}.`)

  // A shopper places an order in a separate browser session.
  const shopper = await browser.newPage()
  await shopper.goto('/product/field-notebook')
  await shopper.getByLabel('Email').fill('sam@example.com')
  await shopper.getByRole('button', { name: 'Place order' }).click()
  const heading = await shopper.getByRole('heading', { name: /^Order #\d+$/ }).textContent()
  const number = heading!.replace('Order ', '')

  const manager = await browser.newPage()
  await signIn(manager, MANAGER)
  const nav = manager.getByRole('navigation', { name: 'Admin' })
  await expect(nav.getByRole('link', { name: 'Plugins' })).toHaveCount(0)
  await nav.getByRole('link', { name: 'Orders' }).click()
  await manager.getByRole('link', { name: number, exact: true }).click()
  await expect(manager.getByTestId('admin-order-status')).toHaveText('Awaiting payment')
  await manager.getByRole('button', { name: 'Mark as paid' }).click()
  await notice(manager, `Order ${number} marked as paid.`)
  await expect(manager.getByTestId('admin-order-status')).toHaveText('Paid')

  await shopper.reload()
  await expect(shopper.getByTestId('order-status')).toHaveText('Paid')

  const forbidden = await manager.goto('/admin/plugins')
  expect(forbidden?.status()).toBe(403)
  await expect(
    manager.getByRole('heading', { name: "You don't have access to this page" }),
  ).toBeVisible()
})

test('signing out ends the session', async ({ page }) => {
  await signIn(page, ADMIN)
  await page.getByRole('button', { name: 'Sign out' }).click()
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
