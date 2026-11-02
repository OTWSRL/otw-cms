import { definePlugin } from '@otw/sdk'
import { registerCapabilities } from './capabilities'
import { AccountOrders, OrderReceivedPage, ProductPage, ShopPage } from './components'
import { migrations } from './migrations'
import { CHECKOUT_ERROR_PARAM, createCheckoutHandler } from './routes/checkout'
import { createCommerceService, createProductPurchasable } from './service'
import type { PaymentGateway } from './types'

export * from './types'
export { CommerceError, type CommerceErrorCode } from './errors'

const CURRENCY = /^[A-Z]{3}$/

/** "Pay later": bank transfer or cash on delivery. Orders stay pending until marked paid by hand. */
export const manualGateway: PaymentGateway = {
  id: 'manual',
  label: 'Pay later',
  description: 'bank transfer or cash on delivery',
  createPayment: async () => ({ type: 'none' }),
}

export default definePlugin({
  id: 'commerce',
  version: '0.1.0',
  name: 'Commerce',
  icon: 'cart',
  description: 'Products, checkout and orders. Other plugins add payment gateways and item types.',
  requires: { core: '^0.1.0' },
  migrations,
  settings: {
    'commerce.currency': {
      type: 'text',
      label: 'Currency',
      description: 'ISO 4217 code. Changing it does not convert existing prices.',
      default: 'USD',
      env: 'COMMERCE_CURRENCY',
      validate: (value) => (CURRENCY.test(value) ? null : 'Use a three-letter code such as USD'),
    },
    'commerce.manualGateway': {
      type: 'boolean',
      label: 'Offer "Pay later"',
      description:
        'Bank transfer or cash on delivery. Mark these orders paid from the order screen.',
      default: true,
    },
  },

  setup(cms) {
    const currency = cms.settings.get('commerce.currency') ?? 'USD'
    // Settings are validated before setup; this guards values passed straight in by code.
    if (!CURRENCY.test(currency)) {
      throw new Error(`commerce.currency must be an ISO 4217 code, got "${currency}"`)
    }

    const gateways = cms.registries.define('commerce.gateways')
    const purchasables = cms.registries.define('commerce.purchasables')
    const commerce = createCommerceService(cms, { gateways, purchasables }, currency)
    cms.services.provide('commerce', commerce)

    purchasables.add(createProductPurchasable(cms))
    if (cms.settings.get('commerce.manualGateway') ?? true) gateways.add(manualGateway)

    cms.routes.page({
      name: 'shop',
      path: '/shop',
      load: () => commerce.listProducts(),
      metadata: () => ({ title: 'Shop' }),
      component: ({ data }) => (
        <ShopPage
          products={data}
          productUrl={(product) => cms.routes.url('commerce.product', { slug: product.slug })}
          format={commerce.formatMoney}
        />
      ),
    })

    cms.routes.page({
      name: 'product',
      path: '/product/:slug',
      load: ({ params }) => commerce.getProductBySlug(params.slug!),
      metadata: ({ data }) => ({ title: data.title, description: data.description || undefined }),
      component: ({ data, searchParams }) => (
        <ProductPage
          product={data}
          gateways={gateways.list()}
          checkoutUrl={cms.routes.apiUrl('/checkout')}
          format={commerce.formatMoney}
          error={first(searchParams[CHECKOUT_ERROR_PARAM])}
        />
      ),
    })

    cms.routes.page({
      name: 'order-received',
      path: '/order/:id/received',
      load: ({ params }) => commerce.getOrder(params.id!),
      metadata: ({ data }) => ({ title: `Order #${data.number}` }),
      component: ({ data }) => <OrderReceivedPage order={data} format={commerce.formatMoney} />,
    })

    cms.routes.api({
      method: 'POST',
      path: '/checkout',
      handler: createCheckoutHandler(cms, commerce),
    })

    cms.slots.fill('header.nav', {
      component: () => <a href={cms.routes.url('commerce.shop')}>Shop</a>,
    })

    // My Account › Orders: the orders placed with the account's proven address.
    cms.slots.fill('account.sections', {
      component: async ({ user }) => {
        const verified = await cms.users.isVerified(user.id)
        const { orders } = verified
          ? await commerce.listOrders({ email: user.email, limit: 20 })
          : { orders: [] }
        return (
          <AccountOrders
            orders={orders}
            verified={verified}
            format={commerce.formatMoney}
            orderUrl={(order) => cms.routes.url('commerce.order-received', { id: order.id })}
          />
        )
      },
    })

    registerCapabilities(cms, manualGateway.id)
  },
})

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
