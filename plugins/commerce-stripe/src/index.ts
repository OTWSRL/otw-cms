import { definePlugin, type PluginDefinition } from '@otw/sdk'
import Stripe from 'stripe'
import {
  dashboardUrl,
  registerOrderPanel,
  registerSettings,
  registerSetupNotice,
  type MissingSetting,
} from './admin'
import { createStripeGateway, type StripeClient } from './gateway'
import { createWebhookHandler } from './webhook'

export { GATEWAY_ID, type StripeClient } from './gateway'

declare module '@otw/sdk' {
  interface Settings {
    /** Offer card payments at checkout. Off stops new card payments; started ones still complete. */
    'commerce-stripe.enabled': boolean
    /** The Stripe secret key (`sk_live_…` or `sk_test_…`), from `STRIPE_SECRET_KEY` only. */
    'commerce-stripe.secretKey': string
    /** The webhook signing secret (`whsec_…`), from `STRIPE_WEBHOOK_SECRET` only. */
    'commerce-stripe.webhookSecret': string
  }
}

/** Options for `createStripePlugin()`. */
export interface StripePluginOptions {
  /** Inject a client (tests, or a preconfigured SDK instance). Otherwise built from settings. */
  client?: StripeClient
}

/**
 * The Stripe plugin with options, such as a client to use in tests. The package's default export
 * is `createStripePlugin()`.
 */
export function createStripePlugin(options: StripePluginOptions = {}): PluginDefinition {
  return definePlugin({
    id: 'commerce-stripe',
    version: '0.1.0',
    name: 'Stripe',
    description: 'Card payments through Stripe Checkout.',
    requires: { core: '^0.1.0', commerce: '^0.1.0' },
    settings: {
      'commerce-stripe.enabled': {
        type: 'boolean',
        label: 'Offer card payments at checkout',
        description: 'Turn off to stop new card payments. Payments already started still complete.',
        default: true,
      },
      'commerce-stripe.secretKey': {
        type: 'secret',
        label: 'Secret key',
        description: 'sk_live_… or sk_test_… from the Stripe dashboard.',
        env: 'STRIPE_SECRET_KEY',
      },
      'commerce-stripe.webhookSecret': {
        type: 'secret',
        label: 'Webhook signing secret',
        description: 'whsec_… for an endpoint pointing at /api/p/commerce-stripe/webhook.',
        env: 'STRIPE_WEBHOOK_SECRET',
      },
    },

    setup(cms) {
      const secretKey = cms.settings.get('commerce-stripe.secretKey')
      const webhookSecret = cms.settings.get('commerce-stripe.webhookSecret')
      registerSettings(cms)
      // Orders paid through Stripe keep their panel even if the keys are later removed.
      registerOrderPanel(cms, dashboardUrl(secretKey))

      const missing: MissingSetting[] = []
      if (!secretKey && !options.client) missing.push('secretKey')
      if (!webhookSecret) missing.push('webhookSecret')
      // The webhook check repeats `missing` so TypeScript narrows the secret below.
      if (!webhookSecret || missing.length > 0) {
        // Active but unconfigured is normal right after install; stay out of checkout until set up.
        cms.logger.warn('Stripe is not configured; card payments are disabled', { missing })
        registerSetupNotice(cms, missing)
        return
      }

      const stripe = options.client ?? new Stripe(secretKey!)
      const commerce = cms.services.get('commerce')
      if (cms.settings.get('commerce-stripe.enabled') ?? true) {
        cms.registries.get('commerce.gateways').add(createStripeGateway(stripe))
      }
      // Registered even when cards are switched off, so checkouts already started still complete.
      cms.routes.api({
        method: 'POST',
        path: '/webhook',
        handler: createWebhookHandler(cms, stripe, webhookSecret, commerce),
      })
    },
  })
}

export default createStripePlugin()
