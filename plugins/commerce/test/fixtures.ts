import type { KernelOptions } from '@otw/core'
import { definePlugin, type PluginDefinition } from '@otw/sdk'
import { createTestKernel, type TestKernel } from '@otw/testing'
import { afterEach } from 'vitest'
import commerce, { type Order, type PaymentGateway, type PaymentUrls } from '../src'
import commerceAdmin from '../src/admin'

let open: TestKernel[] = []

afterEach(async () => {
  await Promise.all(open.map((harness) => harness.close()))
  open = []
})

export async function bootShop(
  extra: PluginDefinition[] = [],
  options: Partial<Omit<KernelOptions, 'db' | 'logger' | 'plugins'>> = {},
) {
  // As the admin boots it: the admin entries too, for the tests of its screens and actions.
  const { admin = [], ...rest } = options
  const harness = await createTestKernel({
    plugins: [commerce, ...extra],
    admin: [commerceAdmin, ...admin],
    ...rest,
  })
  open.push(harness)
  const service = harness.kernel.service('commerce')
  const notebook = await service.createProduct({ slug: 'notebook', title: 'Notebook', price: 1200 })
  const mug = await service.createProduct({
    slug: 'mug',
    title: 'Mug',
    description: 'Holds coffee',
    price: 1800,
  })
  return { ...harness, commerce: service, notebook, mug }
}

/** A third-party discount plugin: 10% off through the totals filter. */
export const tenPercentOff = definePlugin({
  id: 'discounts',
  version: '1.0.0',
  requires: { commerce: '^0.1.0' },
  setup(cms) {
    cms.hooks.addFilter('commerce.cart.totals', (totals) => ({
      ...totals,
      adjustments: [
        ...totals.adjustments,
        { code: 'TEN', label: '10% off', amount: -Math.round(totals.subtotal / 10) },
      ],
    }))
  },
})

/** An LMS-style plugin that sells its own item type and reacts to payment. */
export function coursesPlugin(enrolled: string[]) {
  return definePlugin({
    id: 'courses',
    version: '1.0.0',
    optional: { commerce: '^0.1.0' },
    setup: (cms) =>
      cms.when('commerce', () => {
        cms.registries.get('commerce.purchasables').add({
          id: 'course',
          resolveMany: async (ids) =>
            new Map(
              ids
                .filter((id) => id === 'nextjs-101')
                .map((id) => [id, { title: 'Next.js 101', unitPrice: 9900 }]),
            ),
        })
        cms.hooks.addAction('commerce.order.paid', ({ order }) => {
          for (const line of order.lines)
            if (line.itemType === 'course') enrolled.push(`${order.email}:${line.itemId}`)
        })
      }),
  })
}

/** A gateway plugin that records what commerce asked it to do. */
export function capturingGateway(
  result: Awaited<ReturnType<PaymentGateway['createPayment']>> = {
    type: 'redirect',
    url: 'https://pay.test/session/1',
  },
) {
  const calls: { order: Order; urls: PaymentUrls }[] = []
  const plugin = definePlugin({
    id: 'test-gateway',
    version: '1.0.0',
    requires: { commerce: '*' },
    setup(cms) {
      cms.registries.get('commerce.gateways').add({
        id: 'test',
        label: 'Test',
        createPayment: async (order, urls) => {
          calls.push({ order, urls })
          return result
        },
      })
    },
  })
  return { plugin, calls }
}

/** A plugin whose order.paid listener always throws. */
export const brokenPaidListener = definePlugin({
  id: 'broken-listener',
  version: '1.0.0',
  requires: { commerce: '*' },
  setup: (cms) =>
    cms.hooks.addAction('commerce.order.paid', () => {
      throw new Error('CRM sync down')
    }),
})

export const failingGateway = definePlugin({
  id: 'failing-gateway',
  version: '1.0.0',
  requires: { commerce: '*' },
  setup(cms) {
    cms.registries.get('commerce.gateways').add({
      id: 'flaky',
      label: 'Flaky',
      createPayment: () => Promise.reject(new Error('ECONNRESET')),
    })
  },
})

export const line = (id: string, quantity = 1, type = 'product') => ({ type, id, quantity })
