import { Notice, Postbox } from '@otwdesign/admin-ui'
import type { Order } from '@otwdesign/plugin-commerce'
import { defineAdmin, type AdminDefinition, type PluginContext } from '@otwdesign/sdk'
import { Fragment } from 'react'
import { ENV_NAMES, missingSettings, type MissingSetting } from './config'
import { GATEWAY_ID } from './gateway'
import stripe, { type StripePluginOptions } from './index'

/**
 * Stripe's admin entry, with the options the plugin was given, such as a client in tests. The
 * package's `./admin` export is `createStripeAdmin()`.
 */
export function createStripeAdmin(options: StripePluginOptions = {}): AdminDefinition {
  return defineAdmin(stripe, (cms) => {
    registerSettings(cms)
    // Orders paid through Stripe keep their panel even if the keys are later removed.
    registerOrderPanel(cms, dashboardUrl(cms.settings.get('commerce-stripe.secretKey')))
    const missing = missingSettings(cms, Boolean(options.client))
    if (missing.length > 0) registerSetupNotice(cms, missing)
  })
}

export default createStripeAdmin()

/** Test keys (`sk_test_…`, `rk_test_…`) belong to the dashboard's test mode. */
function dashboardUrl(secretKey: string | undefined): string {
  return secretKey?.includes('_test_')
    ? 'https://dashboard.stripe.com/test'
    : 'https://dashboard.stripe.com'
}

/** Stripe's section on Commerce's Payments page, like a gateway tab in WooCommerce. */
function registerSettings(cms: PluginContext): void {
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
function registerSetupNotice(cms: PluginContext, missing: readonly MissingSetting[]): void {
  cms.slots.fill('admin.notices', {
    component: ({ user }) =>
      cms.auth.can(user, 'core.manage_settings') ? (
        <Notice type="warning">
          <p>
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
        </Notice>
      ) : null,
  })
}

function registerOrderPanel(cms: PluginContext, dashboard: string): void {
  cms.slots.fill('commerce.admin.order', {
    component: ({ order }) => <StripePanel order={order} dashboard={dashboard} />,
  })
}

function StripePanel({ order, dashboard }: { order: Order; dashboard: string }) {
  if (order.gateway !== GATEWAY_ID) return null
  const reference = order.paymentRef
  if (!reference && order.status !== 'pending') return null
  return (
    <Postbox id="stripe-payment" title="Stripe">
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
    </Postbox>
  )
}
