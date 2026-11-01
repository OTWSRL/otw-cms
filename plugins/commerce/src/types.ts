import type { RegistryItem, User } from '@otw/sdk'

/** Money is always an integer in the currency's minor unit (cents for USD). */
export type Money = number

export type OrderStatus = 'pending' | 'paid' | 'cancelled'

export interface Product {
  id: string
  slug: string
  title: string
  description: string
  price: Money
  createdAt: Date
}

export interface NewProduct {
  slug: string
  title: string
  description?: string
  price: Money
}

/** An order without its lines, for listings. */
export type OrderSummary = Omit<Order, 'lines' | 'adjustments'>

export interface OrderListOptions {
  status?: OrderStatus
  /** Defaults to 25, at most 100. */
  limit?: number
  offset?: number
}

/**
 * A kind of thing that can be sold. Commerce sells `product`; other plugins register their own
 * types (an LMS registers `course`) without commerce knowing about them.
 */
export interface Purchasable extends RegistryItem {
  /** The line item type, e.g. `product`. */
  id: string
  /** One lookup per type per checkout. Return only the ids that exist and are for sale. */
  resolveMany(ids: readonly string[]): Promise<Map<string, PurchasableItem>>
}

export interface PurchasableItem {
  title: string
  unitPrice: Money
}

export interface CartLineInput {
  type: string
  id: string
  quantity: number
}

export interface QuotedLine extends CartLineInput {
  title: string
  unitPrice: Money
  lineTotal: Money
}

/** Negative amounts are discounts; positive ones are fees, shipping or tax. */
export interface Adjustment {
  code: string
  label: string
  amount: Money
}

export interface CartTotals {
  subtotal: Money
  adjustments: Adjustment[]
  total: Money
}

export interface Quote {
  currency: string
  lines: QuotedLine[]
  totals: CartTotals
}

export interface OrderLine {
  itemType: string
  itemId: string
  title: string
  unitPrice: Money
  quantity: number
}

export interface Order {
  id: string
  number: number
  email: string
  status: OrderStatus
  gateway: string
  currency: string
  subtotal: Money
  adjustments: Adjustment[]
  total: Money
  paymentRef: string | null
  createdAt: Date
  paidAt: Date | null
  lines: OrderLine[]
}

export type PaymentInit = { type: 'none' } | { type: 'redirect'; url: string }

export interface PaymentUrls {
  success: string
  cancel: string
}

export interface PaymentGateway extends RegistryItem {
  id: string
  label: string
  description?: string
  createPayment(order: Order, urls: PaymentUrls): Promise<PaymentInit>
}

export interface CheckoutInput {
  email: string
  gateway: string
  lines: CartLineInput[]
}

export interface PaymentConfirmation {
  gateway: string
  reference: string
  amount: Money
  currency: string
}

export interface CommerceService {
  readonly currency: string
  listProducts(): Promise<Product[]>
  getProduct(id: string): Promise<Product | null>
  getProductBySlug(slug: string): Promise<Product | null>
  createProduct(input: NewProduct): Promise<Product>
  updateProduct(id: string, input: NewProduct): Promise<Product>
  quote(lines: readonly CartLineInput[]): Promise<Quote>
  /** Creates a pending order, then asks the gateway to start payment. */
  checkout(
    input: CheckoutInput,
    options: { baseUrl: string },
  ): Promise<{ order: Order; payment: PaymentInit }>
  getOrder(id: string): Promise<Order | null>
  /** Newest first. */
  listOrders(options?: OrderListOptions): Promise<{ orders: OrderSummary[]; total: number }>
  /** Pending orders only. Cancelling a cancelled order changes nothing. */
  cancelOrder(id: string): Promise<{ order: Order; changed: boolean }>
  /**
   * Verifies the amount and gateway, then marks the order paid. Idempotent: confirming a paid
   * order again changes nothing and fires nothing, so webhook retries are safe.
   */
  markPaid(
    orderId: string,
    payment: PaymentConfirmation,
  ): Promise<{ order: Order; changed: boolean }>
  formatMoney(amount: Money): string
  /** Parses a price typed in major units ("18.50") for this store's currency. */
  parseMoney(input: string): Money | null
}

declare module '@otw/sdk' {
  interface Registries {
    'commerce.gateways': PaymentGateway
    'commerce.purchasables': Purchasable
  }
  interface Filters {
    /** Add discounts, fees, shipping or tax as adjustments. Subtotal and total are recomputed. */
    'commerce.cart.totals': [CartTotals, { lines: QuotedLine[]; currency: string }]
  }
  interface Actions {
    'commerce.order.created': { order: Order }
    'commerce.order.paid': { order: Order }
    'commerce.order.cancelled': { order: Order }
  }
  interface Services {
    commerce: CommerceService
  }
  interface Settings {
    /** ISO 4217 code. Defaults to USD. */
    'commerce.currency': string
    /** Offer "pay later" (bank transfer / cash on delivery). Defaults to true. */
    'commerce.manualGateway': boolean
  }
  interface Capabilities {
    'commerce.manage_products': true
    'commerce.manage_orders': true
    'commerce.manage_settings': true
  }
  interface MetaCapabilities {
    /**
     * Confirm payment by hand. Commerce allows it for pending "Pay later" orders; a gateway
     * plugin with offline payments (bank transfer, cheques) extends it for its own orders.
     */
    'commerce.mark_order_paid': [order: Order]
    'commerce.cancel_order': [order: Order]
  }
  interface Slots {
    /** Panels on the admin order screen, such as a gateway's payment details. */
    'commerce.admin.order': { order: Order; user: User }
  }
}
