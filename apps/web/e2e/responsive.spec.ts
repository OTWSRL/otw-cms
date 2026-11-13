import { expect, test, type Page } from '@playwright/test'
import { mainMenu, notice, signInAsAdmin, submenu } from './helpers'

/*
 * The admin at WordPress's three layouts, on the device projects in playwright.config.ts:
 * phones (up to 782px: menu behind the bar's button), tablets (783–960px: icons only) and wider
 * screens (full menu). Each test skips the layouts it isn't about.
 */

const PHONE = 782
const FOLDED = 960

const SCREENS = [
  '/admin',
  '/admin/plugins',
  '/admin/users',
  '/admin/users/new',
  '/admin/users/roles',
  '/admin/settings',
  '/admin/library/settings',
  '/admin/library/loans',
  '/admin/library/books',
  '/admin/posts',
  '/admin/posts/new',
  '/admin/pages',
  '/admin/pages/new',
  '/admin/posts/categories',
  '/admin/posts/tags',
]

async function sidewaysScroll(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
}

/** Touch screens get the first tap on a section; the second goes to it, as in WordPress. */
function hoverless(page: Page): Promise<boolean> {
  return page.evaluate(() => window.matchMedia('(hover: none)').matches)
}

async function menuWidth(page: Page): Promise<number | undefined> {
  return (await page.locator('#adminmenuwrap').boundingBox())?.width
}

test('every admin screen fits the screen without scrolling sideways', async ({ page }) => {
  await signInAsAdmin(page)
  for (const path of SCREENS) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    expect(await sidewaysScroll(page), path).toBeLessThanOrEqual(0)
  }
})

// On every device, since each browser engine follows the form's own controls here.
test('a settings field shows only for the choice it belongs to', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/admin/library/settings')
  const via = page.getByLabel('Send notices through')
  const before = await via.inputValue()
  await via.selectOption('none')
  await expect(page.getByLabel('Webhook URL')).toBeHidden()
  await via.selectOption('webhook')
  await expect(page.getByLabel('Webhook URL')).toBeVisible()
  // Left as it was found: nothing is saved here.
  await via.selectOption(before)
})

test.describe('phones', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > PHONE, 'up to 782px')

  test('the menu opens from the admin bar and closes after navigating', async ({ page }) => {
    await signInAsAdmin(page)
    const toggle = page.getByRole('button', { name: 'Menu' })
    await expect(mainMenu(page)).toBeHidden()
    // The button answers once the page's script has loaded, and a tap before that does nothing:
    // tap until the menu has opened, as a person would.
    await expect(async () => {
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 })
    }).toPass()
    await expect(mainMenu(page)).toBeVisible()
    expect(await menuWidth(page)).toBe(190)

    await mainMenu(page).getByRole('link', { name: 'Settings', exact: true }).click()
    if (await hoverless(page)) {
      // The first tap opened the submenu in place.
      await expect(page).toHaveURL(/\/admin(\?|$)/)
      await submenu(page, 'Settings').getByRole('link', { name: 'Library' }).click()
      await expect(page).toHaveURL('/admin/library/settings')
    } else {
      await expect(page).toHaveURL('/admin/settings')
    }
    await expect(mainMenu(page)).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  test('list tables show the main column and expand a row for the rest', async ({ page }) => {
    // The Library fixture's loans: the loan is the main column; the rest folds away.
    await signInAsAdmin(page)
    await page.goto('/admin/library/loans')
    const row = page.getByRole('row', { name: /^L-1001/ })
    const borrower = row.locator('td.column-borrower')
    await expect(row.getByRole('link', { name: 'L-1001', exact: true })).toBeVisible()
    await expect(borrower).toBeHidden()

    const toggle = row.getByRole('button', { name: 'Show more details' })
    await toggle.click()
    await expect(row.getByRole('button', { name: 'Show fewer details' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(borrower).toHaveText('ana@example.com')
    await expect(row.locator('td.column-due')).toBeVisible()
  })

  test('settings forms stack their labels over full-width fields', async ({ page, viewport }) => {
    await signInAsAdmin(page)
    await page.goto('/admin/settings')
    const title = page.getByLabel('Site title')
    const label = page.getByText('Site title', { exact: true })
    const [field, text] = [await title.boundingBox(), await label.boundingBox()]
    expect(field!.y).toBeGreaterThan(text!.y + text!.height - 1)
    // The content area keeps 10px on the left and 12px on the right, as WordPress does.
    expect(field!.width).toBeGreaterThan(viewport!.width - 40)
    // 16px text, so iOS Safari doesn't zoom into the field.
    expect(await title.evaluate((input) => getComputedStyle(input).fontSize)).toBe('16px')
  })

  test('the account menu opens on tap and logs out', async ({ page }) => {
    await signInAsAdmin(page)
    await page.getByRole('button', { name: /^Howdy/ }).click()
    await page.getByRole('button', { name: 'Log Out' }).click()
    await notice(page, 'You are signed out.')
  })
})

test.describe('tablets', () => {
  test.skip(
    ({ viewport }) => (viewport?.width ?? 0) <= PHONE || (viewport?.width ?? 0) > FOLDED,
    '783px to 960px',
  )

  test('the menu folds to icons, and a section opens as a flyout', async ({ page }) => {
    await signInAsAdmin(page)
    expect(await menuWidth(page)).toBe(36)
    const library = mainMenu(page).getByRole('link', { name: 'Library', exact: true })
    // Just the icon: the label is moved off screen, as WordPress does.
    expect((await library.boundingBox())?.width).toBe(36)

    if (await hoverless(page)) {
      await library.click()
      await expect(page).toHaveURL(/\/admin(\?|$)/)
    } else {
      await library.hover()
    }
    await submenu(page, 'Library').getByRole('link', { name: 'Loans' }).click()
    await expect(page).toHaveURL('/admin/library/loans')
  })
})

test.describe('wider screens', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) <= FOLDED, 'over 960px')

  test('Collapse Menu folds the menu and remembers it', async ({ page }) => {
    await signInAsAdmin(page)
    expect(await menuWidth(page)).toBe(160)
    await page.getByRole('button', { name: 'Collapse Menu' }).click()
    expect(await menuWidth(page)).toBe(36)
    await page.reload()
    expect(await menuWidth(page)).toBe(36)
    await page.getByRole('button', { name: 'Collapse Menu' }).click()
    expect(await menuWidth(page)).toBe(160)
    await page.reload()
    expect(await menuWidth(page)).toBe(160)
  })

  test('other sections fly out on hover, or on the first tap', async ({ page }) => {
    await signInAsAdmin(page)
    const users = mainMenu(page).getByRole('link', { name: 'Users', exact: true })
    await expect(submenu(page, 'Users')).toBeHidden()
    if (await hoverless(page)) {
      await users.click()
      await expect(page).toHaveURL(/\/admin(\?|$)/)
    } else {
      await users.hover()
    }
    await expect(submenu(page, 'Users').getByRole('link')).toHaveText([
      'All Users',
      'Add User',
      'Roles',
      'Profile',
    ])
    await submenu(page, 'Users').getByRole('link', { name: 'Roles' }).click()
    await expect(page).toHaveURL('/admin/users/roles')
  })

  test('the current section lists its pages under it', async ({ page }) => {
    await signInAsAdmin(page)
    await page.goto('/admin/library/books')
    await expect(submenu(page, 'Library').getByRole('link', { name: 'Books' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })
})
