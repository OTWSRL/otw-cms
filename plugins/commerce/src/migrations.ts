import type { Migration } from '@cms/sdk'
import { sql } from 'drizzle-orm'

// Hand-written to match schema.ts; the integration tests run every query against this schema.
export const migrations: Migration[] = [
  {
    id: '0001_create_tables',
    up: async (db) => {
      await db.execute(sql`
        CREATE TABLE commerce_products (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          slug text NOT NULL UNIQUE,
          title text NOT NULL,
          description text NOT NULL DEFAULT '',
          price integer NOT NULL CHECK (price >= 0),
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`
        CREATE TABLE commerce_orders (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          number integer GENERATED ALWAYS AS IDENTITY (START WITH 1001) NOT NULL UNIQUE,
          email text NOT NULL,
          status text NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled')),
          gateway text NOT NULL,
          currency char(3) NOT NULL,
          subtotal bigint NOT NULL CHECK (subtotal >= 0),
          adjustments jsonb NOT NULL DEFAULT '[]',
          total bigint NOT NULL CHECK (total >= 0),
          payment_ref text,
          created_at timestamptz NOT NULL DEFAULT now(),
          paid_at timestamptz
        )
      `)
      await db.execute(sql`
        CREATE TABLE commerce_order_lines (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          order_id uuid NOT NULL REFERENCES commerce_orders (id) ON DELETE CASCADE,
          position integer NOT NULL,
          item_type text NOT NULL,
          item_id text NOT NULL,
          title text NOT NULL,
          unit_price integer NOT NULL CHECK (unit_price >= 0),
          quantity integer NOT NULL CHECK (quantity > 0)
        )
      `)
      await db.execute(
        sql`CREATE INDEX commerce_order_lines_order_id_idx ON commerce_order_lines (order_id)`,
      )
    },
  },
]
