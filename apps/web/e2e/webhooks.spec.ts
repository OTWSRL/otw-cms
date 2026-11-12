import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { mainMenu, notice, openSection, signInAsAdmin } from './helpers'

/** The test's own endpoint, which the site delivers to. */
const PORT = 3198
const ENDPOINT = `http://127.0.0.1:${PORT}/hooks`

interface Delivery {
  headers: Record<string, string | string[] | undefined>
  body: string
}

const deliveries: Delivery[] = []
let server: Server

test.beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      deliveries.push({ headers: request.headers, body })
      response.writeHead(200).end('ok')
    })
  })
  await new Promise<void>((done) => server.listen(PORT, '127.0.0.1', done))
})

test.afterAll(async () => {
  await new Promise((done) => server.close(() => done(null)))
})

/** The next delivery of `type` to arrive. */
async function delivered(type: string) {
  await expect
    .poll(() => deliveries.some((one) => JSON.parse(one.body).type === type), { timeout: 20_000 })
    .toBe(true)
  const delivery = deliveries.find((one) => JSON.parse(one.body).type === type)!
  return { ...delivery, event: JSON.parse(delivery.body) }
}

test('a webhook is added in Settings, tested, and told when a post is published', async ({
  page,
}) => {
  await signInAsAdmin(page)
  await openSection(page, 'Settings')
  await mainMenu(page).getByRole('link', { name: 'Webhooks', exact: true }).click()
  await expect(page).toHaveURL('/admin/settings/webhooks')
  await expect(page.getByText('No webhooks yet.')).toBeVisible()

  await page.getByRole('link', { name: 'Add Webhook' }).click()
  await page.getByLabel('Name').fill('Search index')
  await page.getByLabel('Delivery URL').fill(ENDPOINT)
  await page.getByRole('checkbox', { name: /Entry saved/ }).check()
  await page.getByRole('button', { name: 'Add Webhook' }).click()
  await notice(page, 'Webhook added.')
  await expect(page.getByRole('heading', { name: 'Edit Webhook', level: 1 })).toBeVisible()
  const secret = await page.getByLabel('Secret', { exact: true }).inputValue()
  expect(secret).toMatch(/^whsec_/)

  // A test delivery, signed so the receiver can tell it's from this site.
  await page.getByRole('button', { name: 'Send a test' }).click()
  await notice(page, /^A test delivery is on its way/)
  const ping = await delivered('webhook.test')
  expect(ping.event.data).toEqual({ message: 'A test of the webhook “Search index”.' })
  const id = String(ping.headers['webhook-id'])
  const timestamp = String(ping.headers['webhook-timestamp'])
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  expect(ping.headers['webhook-signature']).toBe(
    `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${ping.body}`).digest('base64')}`,
  )

  // Publishing a post tells the endpoint, once the save has been answered.
  await page.goto('/admin/posts/new')
  await page.getByLabel('Add title').fill('News for the webhook')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await notice(page, 'Post published.')
  const saved = await delivered('content.saved')
  expect(saved.event.data).toMatchObject({
    type: 'core.post',
    status: 'published',
    title: 'News for the webhook',
    url: expect.stringContaining('news-for-the-webhook'),
  })

  // The list says how the last delivery went, and the webhook can be deleted.
  await page.goto('/admin/settings/webhooks')
  const row = page.getByRole('row', { name: /Search index/ })
  await expect(row).toContainText('Active')
  await expect(row).toContainText('Entry saved')
  await expect(row).toContainText('The endpoint answered 200.')
  await row.hover()
  await row.getByRole('button', { name: 'Delete “Search index”' }).click()
  await notice(page, 'Webhook deleted.')
  await expect(page.getByText('No webhooks yet.')).toBeVisible()
})
