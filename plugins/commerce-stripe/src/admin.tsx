import type { Order } from '@cms/plugin-commerce'
import type { PluginContext } from '@cms/sdk'
import { Fragment } from 'react'
import { GATEWAY_ID } from './gateway'

const ENV_NAMES = {
  secretKey: 'STRIPE_SECRET_KEY',
  webhookSecret: 'STRIPE_WEBHOOK_SECRET',
} as const

export type MissingSetting = keyof typeof ENV_NAMES

/** Test keys (`sk_test_…`, `rk_test_…`) belong to the dashboard's test mode. */
export function dashboardUrl(secretKey: string | undefined): string {
  return secretKey?.includes('_test_')
    ? 'https://dashboard.stripe.com/test'
    : 'https://dashboard.stripe.com'
}

/** Stripe's section on Commerce's Payments page, like a gateway tab in WooCommerce. */
export function registerSettings(cms: PluginContext): void {
  cms.admin.settingsSection({
    name: 'stripe',
    page: 'commerce.payments',
    title: 'Stripe',
    description: 'Card payments through Stripe Checkout. Keys come from the server environment.',
    fields: [
      'commerce-stripe.enabled',
      'commerce-stripe.secretKey',
      'commerce-stripe.webhookSecret',
    ],
  })
}

/** Tells the people who run the site why cards aren't offered, on every admin screen. */
export function registerSetupNotice(cms: PluginContext, missing: readonly MissingSetting[]): void {
  cms.slots.fill('admin.notices', {
    component: ({ user }) =>
      cms.auth.can(user, 'core.manage_settings') ? (
        <p className="cms-notice cms-notice-warning">
          Stripe is active, but card payments are off until{' '}
          {missing.map((name, index) => (
            <Fragment key={name}>
              {index > 0 && ' and '}
              <code>{ENV_NAMES[name]}</code>
            </Fragment>
          ))}{' '}
          {missing.length > 1 ? 'are' : 'is'} set on the server.{' '}
          <a href={cms.admin.url('commerce.payments')}>Payment settings</a>
        </p>
      ) : null,
  })
}

export function registerOrderPanel(cms: PluginContext, dashboard: string): void {
  cms.slots.fill('commerce.admin.order', {
    component: ({ order }) => <StripePanel order={order} dashboard={dashboard} />,
  })
}

function StripePanel({ order, dashboard }: { order: Order; dashboard: string }) {
  if (order.gateway !== GATEWAY_ID) return null
  const reference = order.paymentRef
  if (!reference && order.status !== 'pending') return null
  return (
    <section className="cms-panel" aria-labelledby="stripe-payment">
      <h2 id="stripe-payment">Stripe</h2>
      {reference ? (
        <p>
          Checkout session <code>{reference}</code>.{' '}
          <a
            href={`${dashboard}/search?query=${encodeURIComponent(reference)}`}
            target="_blank"
            rel="noreferrer"
          >
            Find it in Stripe
          </a>
        </p>
      ) : (
        <p>Waiting for Stripe to confirm the payment. Orders update when the webhook arrives.</p>
      )}
    </section>
  )
}
