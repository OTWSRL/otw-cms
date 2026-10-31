import type { PaymentGateway } from '@cms/plugin-commerce'
import type Stripe from 'stripe'

export const GATEWAY_ID = 'stripe'

/** The slice of the Stripe SDK this plugin uses; tests inject a fake. */
export interface StripeClient {
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ): Promise<{ id: string; url: string | null }>
    }
  }
  webhooks: {
    constructEvent(payload: string, header: string, secret: string): Stripe.Event
  }
}

/** Hosted Stripe Checkout: the shopper is redirected to Stripe, then back to the order page. */
export function createStripeGateway(stripe: StripeClient): PaymentGateway {
  return {
    id: GATEWAY_ID,
    label: 'Card',
    description: 'secure payment with Stripe',
    async createPayment(order, urls) {
      if (order.total <= 0) {
        throw new Error(`Stripe cannot charge order ${order.id}: total is ${order.total}`)
      }
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          customer_email: order.email,
          client_reference_id: order.id,
          metadata: { orderId: order.id },
          payment_intent_data: { metadata: { orderId: order.id } },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: order.currency.toLowerCase(),
                unit_amount: order.total,
                product_data: { name: `Order #${order.number}` },
              },
            },
          ],
          success_url: urls.success,
          cancel_url: urls.cancel,
        },
        // A retried checkout for the same order reuses the session instead of creating a second one.
        { idempotencyKey: `commerce-order-${order.id}` },
      )
      if (!session.url) throw new Error(`Stripe session ${session.id} has no redirect URL`)
      return { type: 'redirect', url: session.url }
    },
  }
}
