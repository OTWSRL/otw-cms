import commerce, { type Order } from '@otwdesign/plugin-commerce'
import commerceAdmin from '@otwdesign/plugin-commerce/admin'
import { definePlugin, type SettingsValues } from '@otwdesign/sdk'
import { createTestKernel, type TestKernel } from '@otwdesign/testing'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Stripe from 'stripe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStripePlugin, type StripeClient } from '../src'
import { createStripeAdmin } from '../src/admin'

const WEBHOOK_SECRET = 'whsec_test_secret'
const WEBHOOK = '/api/p/commerce-stripe/webhook'
const signer = new Stripe('sk_test_signing_only')

let harness: TestKernel | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

function fakeStripe(
  session: { id: string; url: string | null } = {
    id: 'cs_1',
    url: 'https://checkout.stripe.test/cs_1',
  },
) {
  const create = vi.fn<StripeClient['checkout']['sessions']['create']>().mockResolvedValue(session)
  const client: StripeClient = { checkout: { sessions: { create } }, webhooks: signer.webhooks }
  return { client, create }
}

const html = (node: ReactNode | Promise<ReactNode>) => renderToStaticMarkup(node as ReactElement)

async function bootStripe(client = fakeStripe().client, settings: SettingsValues = {}) {
  const paid: Order[] = []
  const listener = definePlugin({
    id: 'paid-listener',
    version: '1.0.0',
    requires: { commerce: '*' },
    setup: (cms) =>
      cms.hooks.addAction('commerce.order.paid', ({ order }) => void paid.push(order)),
  })
  harness = await createTestKernel({
    plugins: [commerce, createStripePlugin({ client }), listener],
    admin: [commerceAdmin, createStripeAdmin({ client })],
    settings: { 'commerce-stripe.webhookSecret': WEBHOOK_SECRET, ...settings },
  })
  const service = harness.kernel.service('commerce')
  const mug = await service.createProduct({ slug: 'mug', title: 'Mug', price: 1800 })
  const { order } = await service.checkout(
    {
      email: 'ana@example.com',
      gateway: 'stripe',
      lines: [{ type: 'product', id: mug.id, quantity: 2 }],
    },
    { baseUrl: 'https://shop.test' },
  )
  return { harness, service, order, paid }
}

function sessionEvent(
  order: Order,
  overrides: { type?: string; session?: Partial<Stripe.Checkout.Session> } = {},
): string {
  return JSON.stringify({
    id: 'evt_1',
    object: 'event',
    type: overrides.type ?? 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        object: 'checkout.session',
        payment_status: 'paid',
        amount_total: order.total,
        currency: 'usd',
        metadata: { orderId: order.id },
        ...overrides.session,
      },
    },
  })
}

function deliver(
  payload: string,
  signature = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
) {
  return harness!.request('POST', WEBHOOK, {
    body: payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
  })
}

describe('configuration', () => {
  it('stays out of checkout until configured', async () => {
    harness = await createTestKernel({ plugins: [commerce, createStripePlugin()] })
    expect(harness.kernel.registry('commerce.gateways').has('stripe')).toBe(false)
    expect((await harness.request('POST', WEBHOOK, { body: '{}' })).status).toBe(404)
    expect(harness.logger.entries.find((e) => e.level === 'warn')).toMatchObject({
      message: 'Stripe is not configured; card payments are disabled',
      context: { plugin: 'commerce-stripe', missing: ['secretKey', 'webhookSecret'] },
    })
  })

  it('does not load without commerce', async () => {
    harness = await createTestKernel({ plugins: [createStripePlugin()] })
    expect(harness.kernel.skipped).toEqual([
      { id: 'commerce-stripe', reason: 'requires "commerce" ^1.0.0, which is not installed' },
    ])
  })
})

describe('Stripe gateway', () => {
  it('creates a Checkout session for the order total with an idempotency key', async () => {
    const stripe = fakeStripe()
    const { order } = await bootStripe(stripe.client)
    expect(stripe.create).toHaveBeenCalledOnce()
    const [params, options] = stripe.create.mock.calls[0]!
    expect(params).toMatchObject({
      mode: 'payment',
      customer_email: 'ana@example.com',
      client_reference_id: order.id,
      metadata: { orderId: order.id },
      line_items: [
        {
          quantity: 1,
          price_data: { currency: 'usd', unit_amount: 3600, product_data: { name: 'Order #1001' } },
        },
      ],
      success_url: `https://shop.test/order/${order.id}/received`,
      cancel_url: 'https://shop.test/shop',
    })
    expect(options).toEqual({ idempotencyKey: `commerce-order-${order.id}` })
  })

  it('redirects the shopper to Stripe', async () => {
    const { harness: shop } = await bootStripe()
    const mug = (await shop.kernel.service('commerce').getProductBySlug('mug'))!
    const response = await shop.request('POST', '/api/p/commerce/checkout', {
      form: { email: 'a@b.co', gateway: 'stripe', item_type: 'product', item_id: mug.id },
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://checkout.stripe.test/cs_1')
  })

  it('fails the checkout when Stripe returns no redirect URL', async () => {
    await expect(bootStripe(fakeStripe({ id: 'cs_x', url: null }).client)).rejects.toMatchObject({
      code: 'payment_failed',
    })
  })
})

describe('webhook', () => {
  it('rejects requests without a valid signature', async () => {
    const { order, service } = await bootStripe()
    const payload = sessionEvent(order)
    const missing = await harness!.request('POST', WEBHOOK, { body: payload })
    expect(missing.status).toBe(400)
    const forged = await deliver(
      payload,
      signer.webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong' }),
    )
    expect(forged.status).toBe(400)
    const tampered = await deliver(
      payload.replace('"paid"', '"unpaid"'),
      signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
    )
    expect(tampered.status).toBe(400)
    expect((await service.getOrder(order.id))!.status).toBe('pending')
  })

  it('marks the order paid once, however many times Stripe delivers the event', async () => {
    const { order, service, paid } = await bootStripe()
    const payload = sessionEvent(order)
    expect((await deliver(payload)).status).toBe(200)
    expect((await deliver(payload)).status).toBe(200)
    expect(await service.getOrder(order.id)).toMatchObject({ status: 'paid', paymentRef: 'cs_1' })
    expect(paid.map((o) => o.id)).toEqual([order.id])
  })

  it('handles delayed payment methods when they succeed', async () => {
    const { order, service } = await bootStripe()
    const pending = sessionEvent(order, { session: { payment_status: 'unpaid' } })
    expect((await deliver(pending)).status).toBe(200)
    expect((await service.getOrder(order.id))!.status).toBe('pending')

    const succeeded = sessionEvent(order, { type: 'checkout.session.async_payment_succeeded' })
    expect((await deliver(succeeded)).status).toBe(200)
    expect((await service.getOrder(order.id))!.status).toBe('paid')
  })

  it('acknowledges but refuses a payment that does not match the order', async () => {
    const { order, service } = await bootStripe()
    const response = await deliver(sessionEvent(order, { session: { amount_total: 1 } }))
    expect(response.status).toBe(200)
    expect((await service.getOrder(order.id))!.status).toBe('pending')
    expect(harness!.logger.entries.find((e) => e.level === 'error')?.context).toMatchObject({
      code: 'payment_mismatch',
      order: order.id,
      session: 'cs_1',
    })
  })

  it('acknowledges events for unknown orders and unrelated event types', async () => {
    const { order } = await bootStripe()
    const unknownOrder = sessionEvent(order, {
      session: { metadata: { orderId: '00000000-0000-4000-8000-000000000000' } },
    })
    expect((await deliver(unknownOrder)).status).toBe(200)
    const noMetadata = sessionEvent(order, { session: { metadata: {} } })
    expect((await deliver(noMetadata)).status).toBe(200)
    expect((await deliver(sessionEvent(order, { type: 'customer.created' }))).status).toBe(200)
  })
})

describe('admin', () => {
  it('adds its section to Commerce’s Payments page, keys read-only', async () => {
    const { harness } = await bootStripe()
    const { user } = await harness.signIn()
    const page = harness.kernel.settingsPage('commerce.payments', user)
    if (page.kind !== 'settings') throw new Error(page.kind)
    expect(
      page.view.sections.map((section) => [
        section.title,
        section.fields.map((field) => [field.key, field.locked]),
      ]),
    ).toEqual([
      ['Pay later', [['commerce.manualGateway', false]]],
      [
        'Stripe',
        [
          ['commerce-stripe.enabled', false],
          ['commerce-stripe.secretKey', true],
          ['commerce-stripe.webhookSecret', true],
        ],
      ],
    ])
  })

  it('stops offering cards when switched off, but completes payments already started', async () => {
    const { harness, order } = await bootStripe()
    const { cookie } = await harness.signIn('shop_manager')
    // "Offer card payments" is unchecked, so it is absent from the form.
    const saved = await harness.request('POST', '/api/p/core/actions/save-settings', {
      cookie,
      form: { page: 'commerce.payments', 'commerce.manualGateway': 'on' },
    })
    expect(saved.status).toBe(303)

    const next = await harness.reboot()
    expect(next.setting('commerce-stripe.enabled')).toBe(false)
    expect(next.registry('commerce.gateways').has('stripe')).toBe(false)
    expect((await deliver(sessionEvent(order))).status).toBe(200)
    expect((await next.service('commerce').getOrder(order.id))!.status).toBe('paid')
  })

  it('tells the people who can fix it which keys are missing', async () => {
    harness = await createTestKernel({
      plugins: [commerce, createStripePlugin()],
      admin: [commerceAdmin, createStripeAdmin()],
      settings: { 'commerce-stripe.webhookSecret': WEBHOOK_SECRET },
    })
    const [notice] = harness.kernel.slot('admin.notices')
    const admin = await harness.signIn()
    expect(html(notice!({ user: admin.user }))).toContain(
      'card payments are off until <code>STRIPE_SECRET_KEY</code> is set on the server.',
    )
    const manager = await harness.signIn('shop_manager')
    expect(notice!({ user: manager.user })).toBeNull()
  })

  it('says nothing about the secret key when the plugin was given a client', async () => {
    const { harness } = await bootStripe()
    expect(harness.kernel.slot('admin.notices')).toEqual([])
  })

  it('shows the Checkout session on Stripe orders in the admin', async () => {
    const { harness, order, service } = await bootStripe(fakeStripe().client, {
      'commerce-stripe.secretKey': 'sk_test_123',
    })
    const { user } = await harness.signIn('shop_manager')
    const [panel] = harness.kernel.slot('commerce.admin.order')

    expect(html(panel!({ order, user }))).toContain('Waiting for Stripe to confirm the payment.')
    await deliver(sessionEvent(order))
    const paid = (await service.getOrder(order.id))!
    const markup = html(panel!({ order: paid, user }))
    expect(markup).toContain('Checkout session <code>cs_1</code>')
    expect(markup).toContain('href="https://dashboard.stripe.com/test/search?query=cs_1"')

    const { order: manual } = await service.checkout(
      { email: 'bo@example.com', gateway: 'manual', lines: [order.lines[0]!].map(toLine) },
      { baseUrl: 'https://shop.test' },
    )
    expect(html(panel!({ order: manual, user }))).toBe('')
  })
})

function toLine(line: Order['lines'][number]) {
  return { type: line.itemType, id: line.itemId, quantity: line.quantity }
}
