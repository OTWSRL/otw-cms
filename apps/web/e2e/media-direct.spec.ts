import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { notice, signInAsAdmin } from './helpers'

// Uploads sent straight to storage, past the site: what a storage plugin gives a site whose host
// caps a request's size. The Library fixture's test bucket (fixtures/library/bucket.ts) stands in
// for one, switched on for these tests alone; it takes files of 1 KB or more from the browser.
test.describe.configure({ mode: 'serial' })

const PHOTO = readFileSync(new URL('./fixtures/photo.jpg', import.meta.url))
const NOTE = Buffer.from('Under a kilobyte: through the site')
const SETTINGS = '/admin/library/settings'
const run = Date.now().toString(36)

/** The upload requests a page makes, as `METHOD path`, ids left out. */
function uploadRequests(page: Page) {
  const seen: string[] = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (request.method() === 'GET') return
    if (
      !pathname.startsWith('/api/p/core/media') &&
      !pathname.startsWith('/api/p/library/bucket')
    ) {
      return
    }
    seen.push(`${request.method()} ${pathname.replace(/[0-9a-f-]{36}/, ':id')}`)
  })
  return seen
}

async function useTestBucket(page: Page, on: boolean) {
  await page.goto(SETTINGS)
  await page.getByLabel('Keep uploads in the test bucket').setChecked(on)
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await notice(page, 'Settings saved.')
}

async function uploadOnAddNew(page: Page, files: { name: string; buffer: Buffer }[]) {
  await page.goto('/admin/media/new')
  await page
    .locator('#media-files')
    .setInputFiles(files.map((file) => ({ ...file, mimeType: 'application/octet-stream' })))
  return page.getByRole('list', { name: 'Uploads' })
}

test('with the disk, every upload is one request to the site, as it always was', async ({
  page,
}) => {
  await signInAsAdmin(page)
  const requests = uploadRequests(page)
  const uploads = await uploadOnAddNew(page, [
    { name: `disk-photo-${run}.jpg`, buffer: PHOTO },
    { name: `disk-note-${run}.txt`, buffer: NOTE },
  ])
  await expect(uploads.getByRole('link', { name: 'Edit' })).toHaveCount(2)
  expect(requests).toEqual(['POST /api/p/core/media', 'POST /api/p/core/media'])
  // And the address that would begin a direct upload isn't there.
  const begin = await page.evaluate(async () => {
    const response = await fetch('/api/p/core/media/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a.txt', size: 2000 }),
    })
    return response.status
  })
  expect(begin).toBe(404)
})

test.describe('with a storage that takes files from the browser', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage()
    await signInAsAdmin(page)
    await useTestBucket(page, true)
    await page.close()
  })

  // Back to the disk for the specs that follow, with nothing of these tests left in the library.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage()
    await signInAsAdmin(page)
    for (;;) {
      await page.goto(`/admin/media?s=${run}&mode=list`)
      const row = page
        .getByRole('table', { name: 'Media Library' })
        .getByRole('row')
        .filter({ hasText: /^.*bucket-/ })
        .first()
      if ((await row.count()) === 0) break
      await row.getByRole('link', { name: /\(Edit\)$/ }).click()
      await page.getByRole('button', { name: 'Delete permanently' }).click()
      await notice(page, 'Media file permanently deleted.')
    }
    await useTestBucket(page, false)
    await page.close()
  })

  test('a large file goes straight to storage and comes out an upload like any other', async ({
    page,
  }) => {
    await signInAsAdmin(page)
    const requests = uploadRequests(page)
    const uploads = await uploadOnAddNew(page, [
      { name: `Bucket Photo ${run}.jpg`, buffer: PHOTO },
      { name: `bucket-note-${run}.txt`, buffer: NOTE },
    ])
    await expect(uploads.getByRole('link', { name: 'Edit' })).toHaveCount(2)
    expect(requests).toEqual([
      // The photo: an address is signed, the bytes go to the bucket, the site stores them.
      'POST /api/p/core/media/uploads',
      'PUT /api/p/library/bucket',
      'POST /api/p/core/media/uploads/:id/complete',
      // The note is small: through the site in one request.
      'POST /api/p/core/media',
    ])

    await uploads.getByRole('listitem').first().getByRole('link', { name: 'Edit' }).click()
    await expect(page.getByRole('heading', { name: 'Edit Media' })).toBeVisible()
    await expect(page.getByText('Dimensions: 600 by 400 pixels')).toBeVisible()
    await expect(page.getByText('File type: image/jpeg')).toBeVisible()
    const fileUrl = await page.getByLabel('File URL:').inputValue()
    expect(fileUrl).toMatch(new RegExp(`^/uploads/\\d{4}/\\d{2}/bucket-photo-${run}\\.jpg$`))
    // Its sizes were made from the bytes the bucket held, and nothing waits there any more.
    expect((await page.request.get(fileUrl)).status()).toBe(200)
    expect((await page.request.get(fileUrl.replace('.jpg', '-150x150.jpg'))).status()).toBe(200)
  })

  test('a file that isn’t what its name says is refused once the site has read it', async ({
    page,
  }) => {
    await signInAsAdmin(page)
    const requests = uploadRequests(page)
    const page_ = Buffer.from(`<script>alert(1)</script>${' '.repeat(2000)}`)
    const uploads = await uploadOnAddNew(page, [{ name: `bucket-fake-${run}.jpg`, buffer: page_ }])
    await expect(uploads.getByRole('alert')).toHaveText(
      `“bucket-fake-${run}.jpg” wasn't uploaded: The file isn't a valid JPG image.`,
    )
    expect(requests.at(-1)).toBe('POST /api/p/core/media/uploads/:id/complete')
    // A type that's never allowed is refused before a byte is sent.
    const refused = await uploadOnAddNew(page, [
      { name: `bucket-setup-${run}.exe`, buffer: Buffer.alloc(4000, 1) },
    ])
    await expect(refused.getByRole('alert')).toHaveText(
      `“bucket-setup-${run}.exe” wasn't uploaded: This file type isn't allowed.`,
    )
    expect(requests.filter((request) => request.startsWith('PUT'))).toHaveLength(1)
  })

  test('a file the storage won’t take says so, and the site forgets it', async ({ page }) => {
    await signInAsAdmin(page)
    const requests = uploadRequests(page)
    // As a bucket whose CORS rules don't allow the site: the browser never gets an answer.
    await page.route('**/api/p/library/bucket**', (route) => route.abort())
    const uploads = await uploadOnAddNew(page, [{ name: `bucket-lost-${run}.jpg`, buffer: PHOTO }])
    await expect(uploads.getByRole('alert')).toContainText(
      'The file couldn’t be sent to storage. If every file fails, the storage doesn’t accept uploads from this site',
    )
    await expect.poll(() => requests.at(-1)).toBe('DELETE /api/p/core/media/uploads/:id')
  })

  test('the editor’s picker sends a large image the same way, attached to its entry', async ({
    page,
  }) => {
    await signInAsAdmin(page)
    await page.goto('/admin/posts/new')
    await page.getByLabel('Add title').fill(`Bucket post ${run}`)
    await page.getByRole('button', { name: 'Save Draft' }).click()
    await notice(page, 'Post draft updated.')
    const requests = uploadRequests(page)
    const content = page.getByRole('textbox', { name: /content$/ })
    await content.click()
    await page.getByRole('button', { name: 'Image', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Add image' })
    await picker.getByRole('tab', { name: 'Upload files' }).click()
    const begun = page.waitForRequest((request) =>
      request.url().endsWith('/api/p/core/media/uploads'),
    )
    await picker
      .locator('#media-modal-file')
      .setInputFiles({ name: `bucket-harbour-${run}.jpg`, mimeType: 'image/jpeg', buffer: PHOTO })
    const entry = new URL(page.url()).pathname.split('/').at(-1)
    expect((await begun).postDataJSON()).toEqual({
      name: `bucket-harbour-${run}.jpg`,
      size: PHOTO.byteLength,
      entry,
    })
    await expect(
      picker.getByRole('button', { name: `bucket-harbour-${run}`, pressed: true }),
    ).toBeVisible()
    await picker.getByRole('button', { name: 'Insert image' }).click()
    await expect(content.locator('img.block-editor-image')).toHaveAttribute(
      'src',
      new RegExp(`/uploads/\\d{4}/\\d{2}/bucket-harbour-${run}\\.jpg$`),
    )
    expect(requests).toEqual([
      'POST /api/p/core/media/uploads',
      'PUT /api/p/library/bucket',
      'POST /api/p/core/media/uploads/:id/complete',
    ])
  })
})
