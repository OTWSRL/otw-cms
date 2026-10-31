import commerce, { type Order } from '@cms/plugin-commerce'
import { definePlugin } from '@cms/sdk'
import { createTestKernel, type TestKernel } from '@cms/testing'
import Stripe from 'stripe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStripePlugin, type StripeClient } from '../src'

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

async function bootStripe(client = fakeStripe().client) {
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
    settings: { 'commerce-stripe.webhookSecret': WEBHOOK_SECRET },
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
      { id: 'commerce-stripe', reason: 'requires "commerce" ^0.1.0, which is not installed' },
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
