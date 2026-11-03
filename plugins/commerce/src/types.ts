import type { RegistryItem, User } from '@otwdesign/sdk'

/** Money is always an integer in the currency's minor unit (cents for USD). */
export type Money = number

/** `pending` until paid or cancelled; paid and cancelled orders don't change again. */
export type OrderStatus = 'pending' | 'paid' | 'cancelled'

/** A product in the shop, sold at `/product/{slug}`. */
export interface Product {
  id: string
  slug: string
  title: string
  description: string
  price: Money
  createdAt: Date
}

/** What creating or updating a product takes. Slugs are lowercased and must be unique. */
export interface NewProduct {
  slug: string
  title: string
  description?: string
  price: Money
}

/** An order without its lines, for listings. */
export type OrderSummary = Omit<Order, 'lines' | 'adjustments'>

/** Which orders `listOrders()` returns: a status, and a page of them. */
export interface OrderListOptions {
  status?: OrderStatus
  /** Orders placed with this address, as an account's are found: compared in lower case. */
  email?: string
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

/** What a purchasable says about one item: its name on the order, and its price now. */
export interface PurchasableItem {
  title: string
  unitPrice: Money
}

/** A line in a cart: which item (a purchasable `type` and its `id`) and how many. */
export interface CartLineInput {
  type: string
  id: string
  quantity: number
}

/** A cart line with the title and price its purchasable gave it. */
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

/** A cart's subtotal, the adjustments filters added, and what's due. */
export interface CartTotals {
  subtotal: Money
  adjustments: Adjustment[]
  total: Money
}

/** A priced cart, before any order exists: what `quote()` returns and checkout charges. */
export interface Quote {
  currency: string
  lines: QuotedLine[]
  totals: CartTotals
}

/** A line on an order, kept as it was sold: later price changes don't touch it. */
export interface OrderLine {
  itemType: string
  itemId: string
  title: string
  unitPrice: Money
  quantity: number
}

/** An order with its lines and adjustments. `number` is the sequential one shown to people. */
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

/** How a gateway starts payment: nothing to do now (pay later), or send the buyer to a URL. */
export type PaymentInit = { type: 'none' } | { type: 'redirect'; url: string }

/** Where a gateway sends the buyer back to: the order-received page, or the shop. */
export interface PaymentUrls {
  success: string
  cancel: string
}

/** A way to pay, added to the `commerce.gateways` registry and offered at checkout. */
export interface PaymentGateway extends RegistryItem {
  id: string
  label: string
  description?: string
  createPayment(order: Order, urls: PaymentUrls): Promise<PaymentInit>
}

/** What checkout takes: the buyer's email, the gateway's id, and the cart. */
export interface CheckoutInput {
  email: string
  gateway: string
  lines: CartLineInput[]
}

/** A gateway's proof of payment, which `markPaid()` checks against the order. */
export interface PaymentConfirmation {
  gateway: string
  reference: string
  amount: Money
  currency: string
}

/** The `commerce` service: products, quotes, checkout and orders, for other plugins. */
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

declare module '@otwdesign/sdk' {
  interface Registries {
    /** Payment methods offered at checkout. Commerce adds "Pay later" unless it's switched off. */
    'commerce.gateways': PaymentGateway
    /** Kinds of things that can be sold. Commerce adds `product`; an LMS would add `course`. */
    'commerce.purchasables': Purchasable
  }
  interface Filters {
    /** Add discounts, fees, shipping or tax as adjustments. Subtotal and total are recomputed. */
    'commerce.cart.totals': [CartTotals, { lines: QuotedLine[]; currency: string }]
  }
  interface Actions {
    /**
     * A pending order was created at checkout, before the gateway starts payment. Runs inside the
     * order's transaction, so handlers' writes commit or roll back with it.
     */
    'commerce.order.created': { order: Order }
    /**
     * An order was paid: by a gateway's webhook, or marked paid by hand. Fires once per order,
     * inside the transaction that marks it paid, so fulfilment (enrolling, shipping) can rely on it.
     */
    'commerce.order.paid': { order: Order }
    /** A pending order was cancelled, inside the transaction that cancels it. */
    'commerce.order.cancelled': { order: Order }
  }
  interface Services {
    /** Commerce's API: products, quotes, checkout and orders. */
    commerce: CommerceService
  }
  interface Settings {
    /** ISO 4217 code. Defaults to USD. */
    'commerce.currency': string
    /** Offer "pay later" (bank transfer / cash on delivery). Defaults to true. */
    'commerce.manualGateway': boolean
  }
  interface Capabilities {
    /** Add and edit products. Shop managers have it. */
    'commerce.manage_products': true
    /** See orders, and mark them paid or cancel them where the meta capabilities allow. Shop managers have it. */
    'commerce.manage_orders': true
    /** Change Settings › Shop and Settings › Payments. Shop managers have it. */
    'commerce.manage_settings': true
  }
  interface MetaCapabilities {
    /**
     * Confirm payment by hand. Commerce allows it for pending "Pay later" orders; a gateway
     * plugin with offline payments (bank transfer, cheques) extends it for its own orders.
     */
    'commerce.mark_order_paid': [order: Order]
    /** Cancel an order. Needs `commerce.manage_orders`, and only while the order is pending. */
    'commerce.cancel_order': [order: Order]
  }
  interface Slots {
    /** Panels on the admin order screen, such as a gateway's payment details. */
    'commerce.admin.order': { order: Order; user: User }
  }
}
