import type { Migration } from '@otw/sdk'
import { sql } from 'drizzle-orm'

// Hand-written to match core-schema.ts; the integration tests run every query against it.
export const coreMigrations: Migration[] = [
  {
    id: '0001_core_tables',
    up: async (db) => {
      await db.execute(sql`
        CREATE TABLE cms_users (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          email text NOT NULL UNIQUE CHECK (email = lower(email)),
          name text NOT NULL DEFAULT '',
          role text NOT NULL,
          password_hash text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`
        CREATE TABLE cms_sessions (
          token_hash text PRIMARY KEY,
          user_id uuid NOT NULL REFERENCES cms_users (id) ON DELETE CASCADE,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`CREATE INDEX cms_sessions_user_id_idx ON cms_sessions (user_id)`)
      await db.execute(sql`
        CREATE TABLE cms_login_failures (
          email text NOT NULL,
          failed_at timestamptz NOT NULL
        )
      `)
      await db.execute(
        sql`CREATE INDEX cms_login_failures_email_idx ON cms_login_failures (email, failed_at)`,
      )
      await db.execute(sql`
        CREATE TABLE cms_plugins (
          id text PRIMARY KEY,
          active boolean NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`
        CREATE TABLE cms_settings (
          key text PRIMARY KEY,
          value jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`
        CREATE TABLE cms_options (
          key text PRIMARY KEY,
          value text NOT NULL
        )
      `)
    },
  },
]
