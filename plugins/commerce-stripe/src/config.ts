import type { PluginContext } from '@otw/sdk'

/** Where each key comes from: the server's environment only. */
export const ENV_NAMES = {
  secretKey: 'STRIPE_SECRET_KEY',
  webhookSecret: 'STRIPE_WEBHOOK_SECRET',
} as const

export type MissingSetting = keyof typeof ENV_NAMES

/**
 * The keys Stripe still needs before it can take payments, which the main entry and the admin
 * entry both go by. A client given to the plugin stands in for the secret key.
 */
export function missingSettings(cms: PluginContext, hasClient: boolean): MissingSetting[] {
  const missing: MissingSetting[] = []
  if (!cms.settings.get('commerce-stripe.secretKey') && !hasClient) missing.push('secretKey')
  if (!cms.settings.get('commerce-stripe.webhookSecret')) missing.push('webhookSecret')
  return missing
}
