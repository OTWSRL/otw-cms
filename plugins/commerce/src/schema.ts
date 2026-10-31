import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { Adjustment, OrderStatus } from './types'

// Commerce owns these tables. Other plugins read and write orders through the commerce service.

export const products = pgTable('commerce_products', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  price: integer('price').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const orders = pgTable('commerce_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  number: integer('number').notNull().generatedAlwaysAsIdentity({ startWith: 1001 }),
  email: text('email').notNull(),
  status: text('status').$type<OrderStatus>().notNull(),
  gateway: text('gateway').notNull(),
  currency: text('currency').notNull(),
  subtotal: bigint('subtotal', { mode: 'number' }).notNull(),
  adjustments: jsonb('adjustments').$type<Adjustment[]>().notNull(),
  total: bigint('total', { mode: 'number' }).notNull(),
  paymentRef: text('payment_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp('paid_at', { withTimezone: true }),
})

export const orderLines = pgTable(
  'commerce_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    itemType: text('item_type').notNull(),
    itemId: text('item_id').notNull(),
    title: text('title').notNull(),
    unitPrice: integer('unit_price').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (table) => [index('commerce_order_lines_order_id_idx').on(table.orderId)],
)
