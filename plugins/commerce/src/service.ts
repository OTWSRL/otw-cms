import type { Database, PluginContext, Registry } from '@otw/sdk'
import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm'
import { CommerceError } from './errors'
import { orderLines, orders, products } from './schema'
import { createMoneyFormatter, parseMoney, settleTotals, subtotalOf } from './totals'
import type {
  CartLineInput,
  CommerceService,
  NewProduct,
  Order,
  PaymentGateway,
  Purchasable,
  QuotedLine,
} from './types'

export const MAX_QUANTITY = 999
/** commerce_products.price is a Postgres integer. */
export const MAX_PRICE = 2_147_483_647
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

// Listings skip lines and adjustments, so a page of orders is one query.
const orderSummaryColumns = {
  id: orders.id,
  number: orders.number,
  email: orders.email,
  status: orders.status,
  gateway: orders.gateway,
  currency: orders.currency,
  subtotal: orders.subtotal,
  total: orders.total,
  paymentRef: orders.paymentRef,
  createdAt: orders.createdAt,
  paidAt: orders.paidAt,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Postgres rejects malformed uuids with an error; treat them as "not found" instead. */
export const isUuid = (value: string) => UUID.test(value)

export function createCommerceService(
  cms: PluginContext,
  registries: { gateways: Registry<PaymentGateway>; purchasables: Registry<Purchasable> },
  currency: string,
): CommerceService {
  const formatMoney = createMoneyFormatter(currency, cms.settings.get('site.locale') ?? 'en-US')

  const loadOrder = async (db: Database, row: typeof orders.$inferSelect): Promise<Order> => {
    const lines = await db
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, row.id))
      .orderBy(asc(orderLines.position))
    return {
      ...row,
      lines: lines.map(({ itemType, itemId, title, unitPrice, quantity }) => ({
        itemType,
        itemId,
        title,
        unitPrice,
        quantity,
      })),
    }
  }

  const quote: CommerceService['quote'] = async (input) => {
    const lines = mergeLines(input)
    const idsByType = new Map<string, string[]>()
    for (const line of lines)
      idsByType.set(line.type, [...(idsByType.get(line.type) ?? []), line.id])

    const resolved = new Map<string, Awaited<ReturnType<Purchasable['resolveMany']>>>()
    for (const [type, ids] of idsByType) {
      const purchasable = registries.purchasables.get(type)
      if (!purchasable) throw new CommerceError('unknown_item', `Unknown item type "${type}"`)
      resolved.set(type, await purchasable.resolveMany(ids))
    }

    const quoted: QuotedLine[] = lines.map((line) => {
      const item = resolved.get(line.type)?.get(line.id)
      if (!item) {
        throw new CommerceError('unknown_item', 'An item in your cart is no longer available')
      }
      if (!Number.isSafeInteger(item.unitPrice) || item.unitPrice < 0) {
        throw new CommerceError('invalid_total', `Invalid price for ${line.type} ${line.id}`)
      }
      return {
        ...line,
        title: item.title,
        unitPrice: item.unitPrice,
        lineTotal: item.unitPrice * line.quantity,
      }
    })

    const subtotal = subtotalOf(quoted)
    const filtered = await cms.hooks.applyFilters(
      'commerce.cart.totals',
      { subtotal, adjustments: [], total: subtotal },
      { lines: quoted, currency },
    )
    return { currency, lines: quoted, totals: settleTotals(subtotal, filtered) }
  }

  return {
    currency,
    formatMoney,
    parseMoney: (input) => parseMoney(input, currency),

    listProducts: () => cms.db.select().from(products).orderBy(asc(products.title)),

    async getProduct(id) {
      if (!isUuid(id)) return null
      const [row] = await cms.db.select().from(products).where(eq(products.id, id)).limit(1)
      return row ?? null
    },

    async getProductBySlug(slug) {
      const [row] = await cms.db.select().from(products).where(eq(products.slug, slug)).limit(1)
      return row ?? null
    },

    async createProduct(input) {
      const values = validProduct(input)
      const [row] = await cms.db
        .insert(products)
        .values(values)
        .onConflictDoNothing({ target: products.slug })
        .returning()
      if (!row) throw slugTaken()
      return row
    },

    async updateProduct(id, input) {
      const values = validProduct(input)
      if (!isUuid(id)) throw new CommerceError('product_not_found', 'That product no longer exists')
      return cms.transaction(async (tx) => {
        const [clash] = await tx
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.slug, values.slug), ne(products.id, id)))
          .limit(1)
        if (clash) throw slugTaken()
        const [row] = await tx.update(products).set(values).where(eq(products.id, id)).returning()
        if (!row) throw new CommerceError('product_not_found', 'That product no longer exists')
        return row
      })
    },

    quote,

    async checkout(input, { baseUrl }) {
      const gateway = registries.gateways.get(input.gateway)
      if (!gateway) {
        throw new CommerceError('unknown_gateway', 'That payment method is not available')
      }

      const order = await cms.transaction(async (tx) => {
        const { lines, totals } = await quote(input.lines)
        const [row] = await tx
          .insert(orders)
          .values({
            email: input.email.toLowerCase(),
            status: 'pending',
            gateway: gateway.id,
            currency,
            subtotal: totals.subtotal,
            adjustments: totals.adjustments,
            total: totals.total,
          })
          .returning()
        await tx.insert(orderLines).values(
          lines.map((line, position) => ({
            orderId: row!.id,
            position,
            itemType: line.type,
            itemId: line.id,
            title: line.title,
            unitPrice: line.unitPrice,
            quantity: line.quantity,
          })),
        )
        const created = await loadOrder(tx, row!)
        await cms.hooks.doAction('commerce.order.created', { order: created })
        return created
      })

      // The gateway call happens after commit: a slow provider must not hold a transaction open.
      const urls = {
        success: baseUrl + cms.routes.url('commerce.order-received', { id: order.id }),
        cancel: baseUrl + cms.routes.url('commerce.shop'),
      }
      try {
        return { order, payment: await gateway.createPayment(order, urls) }
      } catch (error) {
        cms.logger.error('Payment gateway failed to start payment', {
          gateway: gateway.id,
          order: order.id,
          error,
        })
        throw new CommerceError(
          'payment_failed',
          'The payment provider is unavailable. Please try again.',
          {
            cause: error,
          },
        )
      }
    },

    async getOrder(id) {
      if (!isUuid(id)) return null
      const [row] = await cms.db.select().from(orders).where(eq(orders.id, id)).limit(1)
      return row ? loadOrder(cms.db, row) : null
    },

    async listOrders({ status, limit = DEFAULT_PAGE_SIZE, offset = 0 } = {}) {
      const where = status ? eq(orders.status, status) : undefined
      const [rows, [{ total } = { total: 0 }]] = await Promise.all([
        cms.db
          .select(orderSummaryColumns)
          .from(orders)
          .where(where)
          .orderBy(desc(orders.number))
          .limit(Math.min(Math.max(1, limit), MAX_PAGE_SIZE))
          .offset(Math.max(0, offset)),
        cms.db.select({ total: count() }).from(orders).where(where),
      ])
      return { orders: rows, total }
    },

    cancelOrder(id) {
      if (!isUuid(id)) {
        return Promise.reject(new CommerceError('order_not_found', `Order ${id} not found`))
      }
      return cms.transaction(async (tx) => {
        const [row] = await tx.select().from(orders).where(eq(orders.id, id)).for('update')
        if (!row) throw new CommerceError('order_not_found', `Order ${id} not found`)
        if (row.status === 'cancelled') return { order: await loadOrder(tx, row), changed: false }
        if (row.status !== 'pending') {
          throw new CommerceError(
            'invalid_state',
            `Order #${row.number} is ${row.status} and cannot be cancelled`,
          )
        }
        const [updated] = await tx
          .update(orders)
          .set({ status: 'cancelled' })
          .where(eq(orders.id, id))
          .returning()
        const order = await loadOrder(tx, updated!)
        await cms.hooks.doAction('commerce.order.cancelled', { order })
        return { order, changed: true }
      })
    },

    markPaid(orderId, payment) {
      if (!isUuid(orderId)) {
        return Promise.reject(new CommerceError('order_not_found', `Order ${orderId} not found`))
      }
      return cms.transaction(async (tx) => {
        const [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update')
        if (!row) throw new CommerceError('order_not_found', `Order ${orderId} not found`)
        if (
          row.gateway !== payment.gateway ||
          row.total !== payment.amount ||
          row.currency !== payment.currency.toUpperCase()
        ) {
          throw new CommerceError(
            'payment_mismatch',
            `Payment ${payment.reference} (${payment.amount} ${payment.currency} via ${payment.gateway}) does not match order ${row.id}`,
          )
        }
        if (row.status === 'paid') return { order: await loadOrder(tx, row), changed: false }
        if (row.status !== 'pending') {
          throw new CommerceError(
            'invalid_state',
            `Order ${row.id} is ${row.status} and cannot be paid`,
          )
        }

        const [updated] = await tx
          .update(orders)
          .set({ status: 'paid', paidAt: new Date(), paymentRef: payment.reference })
          .where(and(eq(orders.id, orderId), eq(orders.status, 'pending')))
          .returning()
        const order = await loadOrder(tx, updated!)
        await cms.hooks.doAction('commerce.order.paid', { order })
        return { order, changed: true }
      })
    },
  }
}

function validProduct(input: NewProduct): Required<NewProduct> {
  const values = {
    slug: input.slug.trim().toLowerCase(),
    title: input.title.trim(),
    description: (input.description ?? '').trim(),
    price: input.price,
  }
  if (!SLUG.test(values.slug)) {
    throw new CommerceError(
      'invalid_input',
      `Invalid slug "${input.slug}": use lowercase letters, digits and dashes`,
    )
  }
  if (values.title === '' || values.title.length > 200) {
    throw new CommerceError('invalid_input', 'Titles need 1 to 200 characters')
  }
  if (values.description.length > 5000) {
    throw new CommerceError('invalid_input', 'Descriptions are limited to 5000 characters')
  }
  if (!Number.isSafeInteger(values.price) || values.price < 0 || values.price > MAX_PRICE) {
    throw new CommerceError('invalid_input', 'Price must be a non-negative integer in minor units')
  }
  return values
}

function slugTaken(): CommerceError {
  return new CommerceError('invalid_input', 'Another product already uses that slug')
}

function mergeLines(input: readonly CartLineInput[]): CartLineInput[] {
  if (input.length === 0) throw new CommerceError('invalid_input', 'The cart is empty')
  const merged = new Map<string, CartLineInput>()
  for (const line of input) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw new CommerceError('invalid_input', 'Quantities must be whole numbers above zero')
    }
    const key = `${line.type}\u0000${line.id}`
    const existing = merged.get(key)
    merged.set(key, { ...line, quantity: (existing?.quantity ?? 0) + line.quantity })
  }
  const lines = [...merged.values()]
  if (lines.some((line) => line.quantity > MAX_QUANTITY)) {
    throw new CommerceError('invalid_input', `You can order at most ${MAX_QUANTITY} of an item`)
  }
  return lines
}

export function createProductPurchasable(cms: PluginContext): Purchasable {
  return {
    id: 'product',
    async resolveMany(ids) {
      const valid = ids.filter(isUuid)
      if (valid.length === 0) return new Map()
      const rows = await cms.db.select().from(products).where(inArray(products.id, valid))
      return new Map(rows.map((row) => [row.id, { title: row.title, unitPrice: row.price }]))
    },
  }
}
