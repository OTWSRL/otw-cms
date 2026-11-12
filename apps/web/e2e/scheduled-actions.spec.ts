import { expect, test } from '@playwright/test'
import { notice, openSection, signInAsAdmin } from './helpers'

test('Tools › Scheduled Actions lists the queue, and runs a waiting action now', async ({
  page,
}) => {
  await signInAsAdmin(page)
  // Tools opens its first page, which is this one.
  await openSection(page, 'Tools')
  await expect(page).toHaveURL('/admin/tools/scheduled-actions')
  await expect(page.getByRole('heading', { name: 'Scheduled Actions', level: 1 })).toBeVisible()

  // Core's daily jobs are queued when a server first looks at its queue, moments after it starts.
  const emptyTrash = page.getByRole('row', { name: /Empty the Trash/ })
  await expect(async () => {
    await page.reload()
    await expect(emptyTrash).toHaveCount(1)
  }).toPass({ timeout: 30_000 })
  await expect(emptyTrash).toContainText('core.empty_trash')
  await expect(emptyTrash).toContainText('Pending')
  await expect(emptyTrash).toContainText('Every day')
  await expect(emptyTrash).toContainText(/In 2[34] hours|In 1 day/)

  // Run it now: it runs once this response is sent, and its next run is queued a day on.
  await emptyTrash.hover()
  await emptyTrash.getByRole('button', { name: 'Run “Empty the Trash' }).click()
  await notice(page, 'The action runs now.')
  await expect(async () => {
    await page.goto('/admin/tools/scheduled-actions?status=done')
    await expect(page.getByRole('row', { name: /Empty the Trash/ })).toContainText('1 try')
  }).toPass({ timeout: 30_000 })
  await page.getByRole('link', { name: /^Pending/ }).click()
  await expect(page.getByRole('row', { name: /Empty the Trash/ })).toContainText('Every day')

  // A waiting action can be cancelled; a search finds actions by name.
  await page.getByLabel('Search actions by name').fill('cleanup')
  await page.getByRole('button', { name: 'Search actions' }).click()
  const cleanup = page.getByRole('row', { name: /Clear out expired sessions/ })
  await expect(page.getByRole('row', { name: /Empty the Trash/ })).toHaveCount(0)
  await cleanup.hover()
  await cleanup.getByRole('button', { name: /^Cancel/ }).click()
  await notice(page, 'Action cancelled.')
  await page.goto('/admin/tools/scheduled-actions?status=cancelled')
  await expect(page.getByRole('row', { name: /Clear out expired sessions/ })).toHaveCount(1)
})
