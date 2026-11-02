import { expect, test, type Browser, type Page } from '@playwright/test'
import { notice, signIn, signInAsAdmin } from './helpers'

// One site; the writers are added by the first test.
test.describe.configure({ mode: 'serial' })

const CONTRIBUTOR = { email: 'cora@example.com', password: 'contributor e2e password' }
const EDITOR = { email: 'ed@example.com', password: 'editor e2e password' }
const AUTHOR = { email: 'ava@example.com', password: 'author e2e password' }

function editor(page: Page) {
  return page.getByRole('textbox', { name: /content$/ })
}

/** A page signed in as `user`, in a browser context of its own. */
async function as(browser: Browser, user: { email: string; password: string }) {
  const page = await (await browser.newContext()).newPage()
  await signIn(page, user)
  await expect(page).toHaveURL(/\/admin(\?|$)/)
  return page
}

async function addUser(page: Page, user: { email: string; password: string }, role: string) {
  await page.goto('/admin/users/new')
  await page.getByLabel('Email (required)').fill(user.email)
  await page.getByLabel('Password (required)').fill(user.password)
  await page.getByLabel('Role').selectOption({ label: role })
  await page.getByRole('button', { name: 'Add User' }).click()
  await notice(page, `Added ${user.email}.`)
}

test('an administrator writes, formats and publishes a post, and finds it in the list', async ({
  page,
}) => {
  await signInAsAdmin(page)
  await addUser(page, CONTRIBUTOR, 'Contributor')
  await addUser(page, EDITOR, 'Editor')
  await addUser(page, AUTHOR, 'Author')

  await page.goto('/admin/posts')
  await page.getByRole('link', { name: 'Add New Post' }).first().click()
  await expect(page).toHaveURL('/admin/posts/new')
  await page.getByLabel('Add title').fill('Spring opening hours')
  await editor(page).click()
  await page.keyboard.type('We open ')
  await page.getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type('at nine')
  await page.getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type(' from March.')
  await page.keyboard.press('Enter')
  await page.getByLabel('Block type').selectOption({ label: 'Heading 2' })
  await page.keyboard.type('Where to find us')

  // A link the server would refuse is refused in the editor first.
  await page.keyboard.press('Shift+Home')
  await page.getByRole('button', { name: 'Link' }).click()
  await page.getByLabel('Link to').fill('javascript:alert(1)')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Use a web or email address, or a path on this site.' }),
  ).toBeVisible()
  await page.getByLabel('Link to').fill('/contact')
  await page.getByLabel('Link to').press('Enter')
  await expect(editor(page).getByRole('link', { name: 'Where to find us' })).toHaveAttribute(
    'href',
    '/contact',
  )

  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await notice(page, 'Post published.')
  await expect(page.getByRole('heading', { name: 'Edit Post' })).toBeVisible()
  await expect(editor(page).locator('strong')).toHaveText('at nine')
  await expect(page.getByRole('textbox', { name: 'Slug' })).toHaveValue('spring-opening-hours')
  await expect(page.getByRole('button', { name: 'Update' })).toBeVisible()

  await page.goto('/admin/posts')
  const row = page.getByRole('row', { name: /Spring opening hours/ })
  await expect(row).toContainText('Ada Admin')
  await expect(row).toContainText('Published')
  await page.getByRole('searchbox', { name: 'Search posts' }).fill('nine')
  await page.getByRole('button', { name: 'Search Posts' }).click()
  await expect(page.getByRole('row', { name: /Spring opening hours/ })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search posts' }).fill('winter')
  await page.getByRole('button', { name: 'Search Posts' }).click()
  await expect(page.getByText('No posts found.')).toBeVisible()
})

test('a contributor submits a post for review, and an editor publishes it', async ({ browser }) => {
  const contributor = await as(browser, CONTRIBUTOR)
  // Pages are editors'.
  await expect(contributor.getByRole('link', { name: 'Pages', exact: true })).toHaveCount(0)
  await contributor.goto('/admin/posts/new')
  await contributor.getByLabel('Add title').fill('A guest post')
  await editor(contributor).click()
  await contributor.keyboard.type('Hello from a contributor.')
  await expect(contributor.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0)
  await contributor.getByRole('button', { name: 'Submit for Review' }).click()
  await notice(contributor, 'Post submitted.')
  await contributor.goto('/admin/posts')
  await expect(contributor.getByRole('row', { name: /A guest post/ })).toContainText(
    'A guest post — Pending',
  )
  // Someone else's published post is listed, but not theirs to edit.
  const published = contributor.getByRole('row', { name: /Spring opening hours/ })
  await expect(published.getByRole('link', { name: /Edit/ })).toHaveCount(0)

  const editorPage = await as(browser, EDITOR)
  await editorPage.goto('/admin/posts?status=pending')
  await editorPage.getByRole('link', { name: '“A guest post” (Edit)' }).click()
  await editorPage.getByRole('button', { name: 'Publish', exact: true }).click()
  await notice(editorPage, 'Post published.')
  await expect(editorPage.getByRole('combobox', { name: 'Author' })).toHaveValue(/.+/)
  await expect(
    editorPage.getByRole('combobox', { name: 'Author' }).locator('option:checked'),
  ).toHaveText(CONTRIBUTOR.email)
})

test('posts go to the trash, come back as drafts, and are deleted for good', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/admin/posts')
  const row = page.getByRole('row', { name: /A guest post/ })
  await row.hover()
  await row.getByRole('button', { name: 'Trash' }).click()
  await notice(page, '1 post moved to the Trash.')
  await page.getByRole('link', { name: /^Trash/ }).click()
  const trashed = page.getByRole('row', { name: /A guest post/ })
  await trashed.hover()
  await trashed.getByRole('button', { name: 'Restore' }).click()
  await notice(page, '1 post restored from the Trash.')

  await page.goto('/admin/posts?status=draft')
  const draft = page.getByRole('row', { name: /A guest post/ })
  await draft.getByRole('checkbox').check()
  await page.getByLabel('Select bulk action').selectOption({ label: 'Move to Trash' })
  await page.getByRole('button', { name: 'Apply' }).click()
  await notice(page, '1 post moved to the Trash.')
  await page.goto('/admin/posts?status=trash')
  await page.getByRole('button', { name: 'Empty Trash' }).click()
  await notice(page, '1 post permanently deleted.')
  await expect(page.getByText('No posts found in Trash.')).toBeVisible()
})

test('changes a refused save would lose are kept, and restored from the browser', async ({
  page,
  browser,
}) => {
  await signInAsAdmin(page)
  await page.goto('/admin/posts')
  await page.getByRole('link', { name: '“Spring opening hours” (Edit)' }).click()
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('A paragraph only this tab has.')

  // Meanwhile, someone else updates the post.
  const other = await as(browser, EDITOR)
  await other.goto(page.url())
  await other.getByLabel('Add title').fill('Spring opening hours (updated)')
  await other.getByRole('button', { name: 'Update' }).click()
  await notice(other, 'Post updated.')

  await page.getByRole('button', { name: 'Update' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'This changed after you opened it' }),
  ).toBeVisible()
  await expect(page.getByLabel('Add title')).toHaveValue('Spring opening hours (updated)')
  await page.getByRole('button', { name: 'Restore them' }).click()
  await expect(editor(page)).toContainText('A paragraph only this tab has.')
  await expect(page.getByLabel('Add title')).toHaveValue('Spring opening hours')
  await page.getByRole('button', { name: 'Update' }).click()
  await notice(page, 'Post updated.')
  await expect(editor(page)).toContainText('A paragraph only this tab has.')
  await expect(page.getByRole('button', { name: 'Restore them' })).toHaveCount(0)
})

test('pages nest under their parents, and the list shows the tree', async ({ page }) => {
  await signInAsAdmin(page)
  for (const [title, parent] of [
    ['About us', null],
    ['Our team', 'About us'],
    ['Contact', null],
  ] as const) {
    await page.goto('/admin/pages/new')
    await page.getByLabel('Add title').fill(title)
    if (parent) await page.getByLabel('Parent').selectOption({ label: parent })
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await notice(page, 'Page published.')
  }
  await page.goto('/admin/pages')
  const titles = await page.locator('tbody .column-title strong').allTextContents()
  expect(titles).toEqual(['About us', '— Our team', 'Contact'])
})

test('categories and tags are added, given to posts, and filter the list', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/admin/posts/categories')
  for (const [name, parent] of [
    ['Events', null],
    ['Concerts', 'Events'],
  ] as const) {
    await page.getByLabel('Name', { exact: true }).fill(name)
    if (parent) await page.getByLabel('Parent Category').selectOption({ label: parent })
    await page.getByRole('button', { name: 'Add New Category' }).click()
    await notice(page, 'Category added.')
  }
  const titles = await page.locator('tbody .column-name strong').allTextContents()
  expect(titles).toEqual(['Events', '— Concerts', 'Uncategorized'])

  await page.goto('/admin/posts/new')
  await page.getByLabel('Add title').fill('Summer concert')
  await page.getByRole('checkbox', { name: 'Concerts' }).check()
  await page.getByRole('textbox', { name: 'Tags' }).fill('music, Outdoors')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await notice(page, 'Post published.')
  await expect(page.getByRole('checkbox', { name: 'Concerts' })).toBeChecked()
  await expect(page.getByRole('textbox', { name: 'Tags' })).toHaveValue('music, Outdoors')

  await page.goto('/admin/posts')
  const row = page.getByRole('row', { name: /Summer concert/ })
  await expect(row.locator('.column-taxonomy-core-category')).toHaveText('Concerts')
  await expect(row.locator('.column-taxonomy-core-tag')).toHaveText('music, Outdoors')
  // A parent category takes in its children's posts, as WordPress's category filter does.
  await page.getByLabel('Filter by category').selectOption({ label: 'Events' })
  await page.getByRole('button', { name: 'Filter' }).click()
  await expect(page.getByRole('row', { name: /Summer concert/ })).toBeVisible()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await page.getByRole('link', { name: 'Outdoors' }).click()
  await expect(page).toHaveURL(/term=/)
  await expect(page.locator('tbody tr')).toHaveCount(1)

  await page.goto('/admin/posts/tags')
  const music = page.getByRole('row', { name: /music/ })
  await expect(music.locator('.column-posts')).toHaveText('1')
})

test('authors add tags as they write, but not categories, which default to Uncategorized', async ({
  browser,
}) => {
  const author = await as(browser, AUTHOR)
  await expect(author.getByRole('link', { name: 'Categories' })).toHaveCount(0)
  await author.goto('/admin/posts/new')
  await author.getByLabel('Add title').fill('An author’s post')
  await author.getByRole('textbox', { name: 'Tags' }).fill('fresh-tag')
  await author.getByRole('button', { name: 'Publish', exact: true }).click()
  await notice(author, 'Post published.')
  await expect(author.getByRole('checkbox', { name: 'Uncategorized' })).toBeChecked()
  expect((await author.goto('/admin/posts/tags'))?.status()).toBe(403)
})
