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
  // Words as they begin, in any case.
  await page.getByRole('searchbox', { name: 'Search posts' }).fill('OPEN')
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
  const editUrl = await row.getByRole('link', { name: 'Edit “A guest post”' }).getAttribute('href')
  await row.hover()
  await row.getByRole('button', { name: 'Trash' }).click()
  await notice(page, '1 post moved to the Trash.')

  // The post's own screen says where it is, and the browser builds the page the server sent: a
  // form inside a paragraph, which browsers split in two, would be a hydration error.
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(editUrl!)
  await expect(page.getByText('This post is in the Trash.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(errors).toEqual([])

  await page.goto('/admin/posts')
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

test('a post scheduled from the editor is published on its date, by the site itself', async ({
  page,
}) => {
  await signInAsAdmin(page)
  await page.goto('/admin/posts/new')
  await page.getByLabel('Add title').fill('Grand opening')
  await editor(page).click()
  await page.keyboard.type('Doors open at ten.')

  // A date ahead turns Publish into Schedule, as in WordPress.
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible()
  await page.getByLabel('Or on (UTC):').fill('2031-05-06T09:30')
  await page.getByRole('button', { name: 'Schedule', exact: true }).click()
  await notice(page, 'Post scheduled for: May 6, 2031, 9:30 AM UTC.')
  await expect(page.getByLabel('Status:')).toHaveValue('scheduled')
  await expect(page.locator('.curtime')).toContainText('Scheduled for: May 6, 2031, 9:30 AM UTC')
  await expect(page.getByLabel('Change the date (UTC):')).toHaveValue('2031-05-06T09:30')
  await expect(page.getByRole('button', { name: 'Update' })).toBeVisible()
  const id = new URL(page.url()).pathname.split('/').pop()!

  // It has its view and its state in the list, and its address isn't open yet.
  await page.goto('/admin/posts')
  const row = page.getByRole('row', { name: /Grand opening/ })
  await expect(row.locator('.post-state')).toHaveText('Scheduled')
  await expect(row).toContainText('ScheduledMay 6, 2031, 9:30 AM UTC')
  await page.getByRole('link', { name: /^Scheduled/ }).click()
  await expect(page).toHaveURL(/status=scheduled/)
  await expect(page.getByRole('row', { name: /Grand opening/ })).toHaveCount(1)
  expect((await page.request.get('/grand-opening')).status()).toBe(404)
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Grand opening' })).toHaveCount(0)

  // The job that will publish it waits in the queue for that date.
  await page.goto('/admin/tools/scheduled-actions?status=pending&s=publish_entry')
  await expect(page.getByRole('row', { name: /Publish a scheduled entry/ })).toContainText(id)

  // Time passes (the Library fixture's clock moves the date to two seconds from now). Nobody
  // touches the site again: its own timer runs the job, and the post is there.
  const moved = await page.evaluate(async (entry) => {
    const response = await fetch('/api/p/library/time-passes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry }),
    })
    return response.status
  }, id)
  expect(moved).toBe(200)
  await page.goto('about:blank')
  await expect
    .poll(async () => (await page.request.get('/grand-opening')).status(), { timeout: 20_000 })
    .toBe(200)
  await page.goto('/grand-opening')
  await expect(page.getByRole('heading', { name: 'Grand opening' })).toBeVisible()
  await expect(page.getByText('Doors open at ten.')).toBeVisible()

  await page.goto('/admin/posts')
  const published = page.getByRole('row', { name: /Grand opening/ })
  await expect(published.locator('.post-state')).toHaveCount(0)
  await expect(published).toContainText('Published')
  // Left as the other tests expect the site: without it.
  await published.hover()
  await published.getByRole('button', { name: 'Trash' }).click()
  await notice(page, '1 post moved to the Trash.')
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

test('revisions keep each save, to compare and restore', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/admin/posts/new')
  await page.getByLabel('Add title').fill('First draft')
  await editor(page).click()
  await page.keyboard.type('First words.')
  await page.getByRole('button', { name: 'Save Draft' }).click()
  await notice(page, 'Post draft updated.')
  await page.getByLabel('Add title').fill('Second draft')
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('Second words.')
  await page.getByRole('button', { name: 'Save Draft' }).click()
  await notice(page, 'Post draft updated.')

  await page.getByRole('link', { name: 'Browse' }).click()
  await expect(
    page.getByRole('heading', { name: 'Compare Revisions of “Second draft”' }),
  ).toBeVisible()
  const diff = page.locator('.revisions-diff')
  await expect(diff.locator('.diff-removed td:last-child')).toHaveText([
    'Removed: First draft',
    'Removed: First words.',
  ])
  await expect(diff.locator('.diff-added td:last-child')).toHaveText([
    'Added: Second draft',
    'Added: Second words.',
  ])

  await page.getByRole('navigation', { name: 'Revisions' }).getByRole('link').nth(1).click()
  await expect(page.getByRole('heading', { name: /^The first revision/ })).toBeVisible()
  await page.getByRole('button', { name: 'Restore This Revision' }).click()
  await notice(page, 'Post restored to the revision from')
  await expect(page.getByLabel('Add title')).toHaveValue('First draft')
  await expect(editor(page)).toHaveText('First words.')
})
