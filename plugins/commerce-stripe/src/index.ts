import { definePlugin, type PluginDefinition } from '@cms/sdk'
import Stripe from 'stripe'
import { createStripeGateway, type StripeClient } from './gateway'
import { createWebhookHandler } from './webhook'

export { GATEWAY_ID, type StripeClient } from './gateway'

declare module '@cms/sdk' {
  interface Settings {
    'commerce-stripe.secretKey': string
    'commerce-stripe.webhookSecret': string
  }
}

export interface StripePluginOptions {
  /** Inject a client (tests, or a preconfigured SDK instance). Otherwise built from settings. */
  client?: StripeClient
}

export function createStripePlugin(options: StripePluginOptions = {}): PluginDefinition {
  return definePlugin({
    id: 'commerce-stripe',
    version: '0.1.0',
    name: 'Stripe',
    description: 'Card payments through Stripe Checkout.',
    requires: { core: '^0.1.0', commerce: '^0.1.0' },
    settings: {
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
      if (!webhookSecret || (!secretKey && !options.client)) {
        // Active but unconfigured is normal right after install; stay out of checkout until set up.
        cms.logger.warn('Stripe is not configured; card payments are disabled', {
          missing: [
            !secretKey && !options.client && 'secretKey',
            !webhookSecret && 'webhookSecret',
          ].filter(Boolean),
        })
        return
      }

      const stripe = options.client ?? new Stripe(secretKey!)
      const commerce = cms.services.get('commerce')
      cms.registries.get('commerce.gateways').add(createStripeGateway(stripe))
      cms.routes.api({
        method: 'POST',
        path: '/webhook',
        handler: createWebhookHandler(cms, stripe, webhookSecret, commerce),
      })
    },
  })
}

export default createStripePlugin()
