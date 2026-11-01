import { HookError } from '@otw/core'
import { definePlugin } from '@otw/sdk'
import { createTestKernel } from '@otw/testing'
import { count } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import commerce, { CommerceError, type Order } from '../src'
import { orders } from '../src/schema'
import {
  bootShop,
  brokenPaidListener,
  capturingGateway,
  coursesPlugin,
  failingGateway,
  line,
  tenPercentOff,
} from './fixtures'

const BASE = { baseUrl: 'https://shop.test' }

const orderCount = async (db: Awaited<ReturnType<typeof bootShop>>['db']) =>
  (await db.select({ n: count() }).from(orders))[0]!.n

describe('quote', () => {
  it('prices lines, merging duplicates', async () => {
    const shop = await bootShop()
    const quote = await shop.commerce.quote([
      line(shop.notebook.id),
      line(shop.mug.id, 2),
      line(shop.notebook.id, 2),
    ])
    expect(quote.lines.map((l) => [l.title, l.quantity, l.lineTotal])).toEqual([
      ['Notebook', 3, 3600],
      ['Mug', 2, 3600],
    ])
    expect(quote.totals).toEqual({ subtotal: 7200, adjustments: [], total: 7200 })
  })

  it('applies adjustments from other plugins through the totals filter', async () => {
    const shop = await bootShop([tenPercentOff])
    const { totals } = await shop.commerce.quote([line(shop.mug.id)])
    expect(totals).toEqual({
      subtotal: 1800,
      adjustments: [{ code: 'TEN', label: '10% off', amount: -180 }],
      total: 1620,
    })
  })

  it.each([
    ['an empty cart', () => [], 'invalid_input'],
    ['an unknown item type', () => [line('x', 1, 'ticket')], 'unknown_item'],
    ['a missing product', () => [line('00000000-0000-4000-8000-000000000000')], 'unknown_item'],
    ['a malformed product id', () => [line("1' OR '1'='1")], 'unknown_item'],
    ['a zero quantity', () => [line('x', 0)], 'invalid_input'],
  ])('rejects %s', async (_name, lines, code) => {
    const shop = await bootShop()
    await expect(shop.commerce.quote(lines())).rejects.toMatchObject({ code })
  })

  it('rejects quantities over the limit after merging lines', async () => {
    const shop = await bootShop()
    await expect(
      shop.commerce.quote([line(shop.mug.id, 500), line(shop.mug.id, 500)]),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })
})

describe('checkout', () => {
  it('creates a pending order with lines and fires order.created', async () => {
    const created: Order[] = []
    const listener = definePlugin({
      id: 'listener',
      version: '1.0.0',
      requires: { commerce: '*' },
      setup: (cms) =>
        cms.hooks.addAction('commerce.order.created', ({ order }) => void created.push(order)),
    })
    const shop = await bootShop([listener])

    const { order, payment } = await shop.commerce.checkout(
      { email: 'Ana@Example.com', gateway: 'manual', lines: [line(shop.mug.id, 2)] },
      BASE,
    )
    expect(payment).toEqual({ type: 'none' })
    expect(order).toMatchObject({
      number: 1001,
      email: 'ana@example.com',
      status: 'pending',
      gateway: 'manual',
      currency: 'USD',
      total: 3600,
      lines: [
        { itemType: 'product', itemId: shop.mug.id, title: 'Mug', unitPrice: 1800, quantity: 2 },
      ],
    })
    expect(created.map((o) => o.id)).toEqual([order.id])
    expect(await shop.commerce.getOrder(order.id)).toEqual(order)
  })

  it('numbers orders sequentially', async () => {
    const shop = await bootShop()
    const input = { email: 'a@b.co', gateway: 'manual', lines: [line(shop.mug.id)] }
    const first = await shop.commerce.checkout(input, BASE)
    const second = await shop.commerce.checkout(input, BASE)
    expect([first.order.number, second.order.number]).toEqual([1001, 1002])
  })

  it("sells another plugin's item type alongside products", async () => {
    const shop = await bootShop([coursesPlugin([])])
    const { order } = await shop.commerce.checkout(
      {
        email: 'a@b.co',
        gateway: 'manual',
        lines: [line(shop.notebook.id), line('nextjs-101', 1, 'course')],
      },
      BASE,
    )
    expect(order.lines.map((l) => `${l.itemType}:${l.title}`)).toEqual([
      'product:Notebook',
      'course:Next.js 101',
    ])
    expect(order.total).toBe(1200 + 9900)
  })

  it('passes the gateway the order and absolute return URLs', async () => {
    const gateway = capturingGateway()
    const shop = await bootShop([gateway.plugin])
    const { order, payment } = await shop.commerce.checkout(
      { email: 'a@b.co', gateway: 'test', lines: [line(shop.mug.id)] },
      BASE,
    )
    expect(payment).toEqual({ type: 'redirect', url: 'https://pay.test/session/1' })
    expect(gateway.calls[0]!.urls).toEqual({
      success: `https://shop.test/order/${order.id}/received`,
      cancel: 'https://shop.test/shop',
    })
  })

  it('rejects an unknown gateway before creating anything', async () => {
    const shop = await bootShop()
    await expect(
      shop.commerce.checkout(
        { email: 'a@b.co', gateway: 'paypal', lines: [line(shop.mug.id)] },
        BASE,
      ),
    ).rejects.toMatchObject({ code: 'unknown_gateway' })
    expect(await orderCount(shop.db)).toBe(0)
  })

  it('rolls the order back when a totals filter breaks', async () => {
    const broken = definePlugin({
      id: 'broken-discounts',
      version: '1.0.0',
      requires: { commerce: '*' },
      setup: (cms) =>
        cms.hooks.addFilter('commerce.cart.totals', () => {
          throw new Error('coupon service down')
        }),
    })
    const shop = await bootShop([broken])
    const error = await shop.commerce
      .checkout({ email: 'a@b.co', gateway: 'manual', lines: [line(shop.mug.id)] }, BASE)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HookError)
    expect(error).toMatchObject({ pluginId: 'broken-discounts' })
    expect(await orderCount(shop.db)).toBe(0)
  })

  it('keeps the pending order and reports payment_failed when the gateway is down', async () => {
    const shop = await bootShop([failingGateway])
    await expect(
      shop.commerce.checkout(
        { email: 'a@b.co', gateway: 'flaky', lines: [line(shop.mug.id)] },
        BASE,
      ),
    ).rejects.toMatchObject({ code: 'payment_failed' })
    expect(await orderCount(shop.db)).toBe(1)
    expect(shop.logger.entries.find((e) => e.level === 'error')?.context).toMatchObject({
      plugin: 'commerce',
      gateway: 'flaky',
    })
  })
})

describe('markPaid', () => {
  async function pendingOrder(extra: Parameters<typeof bootShop>[0] = []) {
    const gateway = capturingGateway()
    const shop = await bootShop([gateway.plugin, ...extra])
    const { order } = await shop.commerce.checkout(
      {
        email: 'ana@example.com',
        gateway: 'test',
        lines: [line(shop.notebook.id), line('nextjs-101', 1, 'course')],
      },
      BASE,
    )
    const payment = { gateway: 'test', reference: 'pay_1', amount: order.total, currency: 'usd' }
    return { shop, order, payment }
  }

  it('marks the order paid and fires order.paid exactly once', async () => {
    const enrolled: string[] = []
    const { shop, order, payment } = await pendingOrder([coursesPlugin(enrolled)])

    const first = await shop.commerce.markPaid(order.id, payment)
    expect(first.changed).toBe(true)
    expect(first.order).toMatchObject({ status: 'paid', paymentRef: 'pay_1' })
    expect(first.order.paidAt).toBeInstanceOf(Date)

    const retry = await shop.commerce.markPaid(order.id, payment)
    expect(retry.changed).toBe(false)
    expect(enrolled).toEqual(['ana@example.com:nextjs-101'])
  })

  it.each([
    ['amount', { amount: 1 }],
    ['currency', { currency: 'eur' }],
    ['gateway', { gateway: 'manual' }],
  ])('refuses a payment with the wrong %s', async (_field, override) => {
    const { shop, order, payment } = await pendingOrder([coursesPlugin([])])
    await expect(
      shop.commerce.markPaid(order.id, { ...payment, ...override }),
    ).rejects.toMatchObject({
      code: 'payment_mismatch',
    })
    expect((await shop.commerce.getOrder(order.id))!.status).toBe('pending')
  })

  it('reports unknown and malformed order ids as not found', async () => {
    const { shop, payment } = await pendingOrder([coursesPlugin([])])
    await expect(
      shop.commerce.markPaid('00000000-0000-4000-8000-000000000000', payment),
    ).rejects.toMatchObject({ code: 'order_not_found' })
    await expect(shop.commerce.markPaid('not-a-uuid', payment)).rejects.toBeInstanceOf(
      CommerceError,
    )
  })

  it('keeps the order paid when an order.paid listener fails', async () => {
    const enrolled: string[] = []
    const { shop, order, payment } = await pendingOrder([
      coursesPlugin(enrolled),
      brokenPaidListener,
    ])

    const { changed } = await shop.commerce.markPaid(order.id, payment)
    expect(changed).toBe(true)
    expect((await shop.commerce.getOrder(order.id))!.status).toBe('paid')
    expect(enrolled).toEqual(['ana@example.com:nextjs-101'])
    expect(
      shop.logger.entries.some(
        (e) => e.level === 'error' && e.context?.plugin === 'broken-listener',
      ),
    ).toBe(true)
  })
})

describe('settings', () => {
  it('uses the configured currency and locale', async () => {
    const shop = await bootShop([], {
      settings: { 'commerce.currency': 'EUR', 'site.locale': 'de-DE' },
    })
    expect(shop.commerce.currency).toBe('EUR')
    expect(shop.commerce.formatMoney(1800)).toBe('18,00 €')
  })

  it('refuses to boot with an invalid currency', async () => {
    await expect(
      createTestKernel({ plugins: [commerce], settings: { 'commerce.currency': 'dollars' } }),
    ).rejects.toThrow('ISO 4217')
  })

  it('can turn off the manual gateway', async () => {
    const shop = await bootShop([], { settings: { 'commerce.manualGateway': false } })
    expect(shop.kernel.registry('commerce.gateways').list()).toEqual([])
  })
})

describe('pages', () => {
  it('serves the shop, product and order pages', async () => {
    const shop = await bootShop()
    const list = await shop.kernel.resolvePage('/shop')
    expect((list!.props.data as { title: string }[]).map((p) => p.title)).toEqual([
      'Mug',
      'Notebook',
    ])

    const product = await shop.kernel.resolvePage('/product/mug')
    expect(await product!.metadata()).toEqual({ title: 'Mug', description: 'Holds coffee' })

    const { order } = await shop.commerce.checkout(
      { email: 'a@b.co', gateway: 'manual', lines: [line(shop.mug.id)] },
      BASE,
    )
    const received = await shop.kernel.resolvePage(`/order/${order.id}/received`)
    expect(await received!.metadata()).toEqual({ title: 'Order #1001' })
  })

  it('404s on unknown products and malformed order ids', async () => {
    const shop = await bootShop()
    expect(await shop.kernel.resolvePage('/product/teapot')).toBeNull()
    expect(await shop.kernel.resolvePage('/order/not-a-uuid/received')).toBeNull()
  })

  it('fills the header navigation slot', async () => {
    const shop = await bootShop()
    expect(shop.kernel.slot('header.nav')).toHaveLength(1)
  })
})
