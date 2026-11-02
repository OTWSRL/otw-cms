import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { notice, signIn, signInAsAdmin } from './helpers'

const PHOTO = readFileSync(new URL('./fixtures/photo.jpg', import.meta.url))

test('an administrator uploads files, edits one, and deletes it with its sizes', async ({
  page,
}) => {
  await signInAsAdmin(page)
  // Names of their own, so the run's other files don't get in the way.
  const run = Date.now().toString(36)
  await page.goto('/admin/media/new')
  await expect(page.getByRole('heading', { name: 'Upload New Media' })).toBeVisible()
  await expect(page.getByText('Maximum upload file size: 64 MB.')).toBeVisible()
  await page.locator('#media-files').setInputFiles([
    { name: `Beach ${run}.jpg`, mimeType: 'image/jpeg', buffer: PHOTO },
    { name: `notes-${run}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Packing list') },
    { name: `setup-${run}.exe`, mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
  ])
  const uploads = page.getByRole('list', { name: 'Uploads' })
  await expect(uploads.getByRole('link', { name: 'Edit' })).toHaveCount(2)
  await expect(uploads.getByRole('alert')).toHaveText(
    `“setup-${run}.exe” wasn't uploaded: This file type isn't allowed.`,
  )

  // The library, as a grid, then as a list with the type filter.
  await page.goto(`/admin/media?s=${run}`)
  const grid = page.getByRole('list', { name: 'Media Library' })
  await expect(grid.getByRole('listitem')).toHaveCount(2)
  await page.getByRole('link', { name: 'List' }).click()
  await page.getByLabel('Filter by type').selectOption({ label: 'Images' })
  await page.getByRole('button', { name: 'Filter' }).click()
  await expect(page).toHaveURL(/filter=image/)
  const rows = page.getByRole('table', { name: 'Media Library' }).getByRole('row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(1)).toContainText(`Beach ${run}`)
  await expect(rows.nth(1)).toContainText(`beach-${run}.jpg`)
  await rows
    .nth(1)
    .getByRole('link', { name: `“Beach ${run}” (Edit)` })
    .click()

  await expect(page.getByRole('heading', { name: 'Edit Media' })).toBeVisible()
  await expect(page.getByText('Dimensions: 600 by 400 pixels')).toBeVisible()
  await expect(page.getByText('File type: image/jpeg')).toBeVisible()
  const fileUrl = await page.getByLabel('File URL:').inputValue()
  expect(fileUrl).toMatch(new RegExp(`^/uploads/\\d{4}/\\d{2}/beach-${run}\\.jpg$`))
  const preview = page.locator('img.media-preview')
  // No bigger than the large size, so the image itself.
  await expect(preview).toHaveAttribute('src', fileUrl)
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(600)

  await page.getByLabel('Alternative Text').fill('A sun over the sea')
  await page.getByLabel('Caption').fill('Day one')
  await page.getByRole('button', { name: 'Update' }).click()
  await notice(page, 'Media file updated.')
  await expect(page.getByLabel('Alternative Text')).toHaveValue('A sun over the sea')
  await expect(preview).toHaveAttribute('alt', 'A sun over the sea')

  // The file and its sizes are served, safely, and go when it's deleted.
  const file = await page.request.get(fileUrl)
  expect(file.status()).toBe(200)
  expect(file.headers()).toMatchObject({
    'content-type': 'image/jpeg',
    'x-content-type-options': 'nosniff',
  })
  const thumbnail = fileUrl.replace('.jpg', '-150x150.jpg')
  expect((await page.request.get(thumbnail)).status()).toBe(200)
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await notice(page, 'Media file permanently deleted.')
  await expect(page).toHaveURL(/\/admin\/media(\?|$)/)
  expect((await page.request.get(fileUrl)).status()).toBe(404)
  expect((await page.request.get(thumbnail)).status()).toBe(404)
})

test('a contributor can’t open the media library, as in WordPress', async ({ page }) => {
  await signInAsAdmin(page)
  const contributor = { email: 'cleo@example.com', password: 'contributor media password' }
  await page.goto('/admin/users/new')
  await page.getByLabel('Email (required)').fill(contributor.email)
  await page.getByLabel('Password (required)').fill(contributor.password)
  await page.getByLabel('Role').selectOption({ label: 'Contributor' })
  await page.getByRole('button', { name: 'Add User' }).click()
  await notice(page, `Added ${contributor.email}.`)
  const other = await (await page.context().browser()!.newContext()).newPage()
  await signIn(other, contributor)
  await expect(other.getByRole('navigation', { name: 'Main menu' })).not.toContainText('Media')
  expect((await other.goto('/admin/media'))?.status()).toBe(403)
})

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('the uploader is a plain form that posts the files', async ({ page }) => {
    await signInAsAdmin(page)
    await page.goto('/admin/media/new')
    await page.locator('input[name="files"]').setInputFiles({
      name: 'Plain Upload.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('no scripts here'),
    })
    await page.getByRole('button', { name: 'Upload' }).click()
    await notice(page, 'Uploaded “Plain Upload.txt”.')
    await expect(page.getByRole('heading', { name: 'Edit Media' })).toBeVisible()
    await expect(page.getByText('File type: text/plain')).toBeVisible()
  })
})

test('a post gets an image in its content and a featured image, which the site shows sized', async ({
  page,
}) => {
  await signInAsAdmin(page)
  const run = Date.now().toString(36)
  await page.goto('/admin/posts/new')
  await page.getByLabel('Add title').fill(`Harbour ${run}`)
  const content = page.getByRole('textbox', { name: /content$/ })
  await content.click()
  await page.keyboard.type('Before the image.')

  // The picker: upload a file, which is chosen at once, then insert it.
  await page.getByRole('button', { name: 'Image', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Add image' })
  await picker.getByRole('tab', { name: 'Upload files' }).click()
  await picker
    .locator('#media-modal-file')
    .setInputFiles({ name: `harbour-${run}.jpg`, mimeType: 'image/jpeg', buffer: PHOTO })
  await expect(picker.getByRole('button', { name: `harbour-${run}`, pressed: true })).toBeVisible()
  await picker.getByRole('button', { name: 'Insert image' }).click()
  await expect(picker).toBeHidden()
  const inserted = content.locator('img.block-editor-image')
  await expect(inserted).toHaveAttribute('src', /\/uploads\/\d{4}\/\d{2}\/harbour-[a-z0-9]+\.jpg$/)
  await inserted.click()
  await page.getByLabel('Alternative text').fill('Boats in the harbour')

  // The featured image, chosen from the library.
  await page.getByRole('button', { name: 'Set featured image' }).click()
  const featured = page.getByRole('dialog', { name: 'Featured image' })
  await featured.getByRole('button', { name: `harbour-${run}` }).click()
  await featured.getByRole('button', { name: 'Set featured image' }).click()
  await expect(page.getByRole('button', { name: /^Change the featured image/ })).toBeVisible()

  await page.getByRole('button', { name: 'Publish' }).click()
  await notice(page, 'Post published.')
  await expect(page.getByRole('button', { name: /^Change the featured image/ })).toBeVisible()
  await expect(content.locator('img.block-editor-image')).toHaveAttribute(
    'alt',
    'Boats in the harbour',
  )

  // On the site: the featured image first, then the content's, each with its sizes.
  // View Post opens a tab of its own; go to its address here.
  await page.goto((await page.getByRole('link', { name: 'View Post' }).getAttribute('href'))!)
  const thumbnail = page.locator('figure.entry-thumbnail img')
  await expect(thumbnail).toHaveAttribute('srcset', /-300x200\.jpg 300w, .+\.jpg 600w$/)
  await expect(thumbnail).toHaveAttribute('loading', 'eager')
  const image = page.locator('.entry-content figure.wp-block-image img')
  await expect(image).toHaveAttribute('alt', 'Boats in the harbour')
  await expect(image).toHaveAttribute('srcset', /300w/)
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)

  // And the latest posts show it as a thumbnail.
  await page.goto('/')
  const item = page.locator('.archive-item').filter({ hasText: `Harbour ${run}` })
  await expect(item.locator('.archive-thumbnail img')).toHaveAttribute('src', /-300x200\.jpg$/)
})
