import {
  CommerceError,
  type CommerceErrorCode,
  type CommerceService,
} from '@otwdesign/plugin-commerce'
import { HttpError, type ApiHandler, type PluginContext } from '@otwdesign/sdk'
import type Stripe from 'stripe'
import { GATEWAY_ID, type StripeClient } from './gateway'

// Retrying the webhook can't fix these, so the event is acknowledged and logged for a human.
const PERMANENT_FAILURES: ReadonlySet<CommerceErrorCode> = new Set([
  'order_not_found',
  'payment_mismatch',
  'invalid_state',
])

/**
 * Stripe retries any non-2xx response for days, so: 400 for requests that aren't from Stripe,
 * 200 for anything handled or permanently unprocessable, 500 only for transient failures.
 */
export function createWebhookHandler(
  cms: PluginContext,
  stripe: StripeClient,
  webhookSecret: string,
  commerce: CommerceService,
): ApiHandler {
  return async (request) => {
    const signature = request.headers.get('stripe-signature')
    if (!signature) throw new HttpError(400, 'Missing Stripe-Signature header')

    // Signature verification needs the exact raw body.
    const payload = await request.text()
    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(payload, signature, webhookSecret)
    } catch (error) {
      cms.logger.warn('Rejected Stripe webhook with an invalid signature', {
        reason: error instanceof Error ? error.message : String(error),
      })
      throw new HttpError(400, 'Invalid signature')
    }

    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      await applyPaidSession(cms, commerce, event.data.object, event.id)
    }
    return Response.json({ received: true })
  }
}

async function applyPaidSession(
  cms: PluginContext,
  commerce: CommerceService,
  session: Stripe.Checkout.Session,
  eventId: string,
): Promise<void> {
  // Delayed methods (bank debits) complete later with async_payment_succeeded.
  if (session.payment_status !== 'paid') return

  const orderId = session.metadata?.orderId
  const context = { event: eventId, session: session.id, order: orderId }
  if (!orderId || session.amount_total === null || !session.currency) {
    cms.logger.warn('Stripe session has no commerce order attached', context)
    return
  }

  try {
    const { changed } = await commerce.markPaid(orderId, {
      gateway: GATEWAY_ID,
      reference: session.id,
      amount: session.amount_total,
      currency: session.currency,
    })
    cms.logger.info(
      changed ? 'Order paid via Stripe' : 'Ignored repeated Stripe confirmation',
      context,
    )
  } catch (error) {
    if (error instanceof CommerceError && PERMANENT_FAILURES.has(error.code)) {
      cms.logger.error('Stripe payment could not be applied to its order', {
        ...context,
        code: error.code,
        error,
      })
      return
    }
    throw error
  }
}
