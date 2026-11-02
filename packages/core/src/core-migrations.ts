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
  {
    id: '0002_entries',
    up: async (db) => {
      await db.execute(sql`
        CREATE TABLE cms_entries (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          type text NOT NULL,
          status text NOT NULL
            CHECK (status IN ('draft', 'pending', 'published', 'private', 'trash')),
          slug text NOT NULL DEFAULT '',
          title text NOT NULL DEFAULT '',
          body jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(body) = 'array'),
          excerpt text NOT NULL DEFAULT '',
          author_id uuid REFERENCES cms_users (id) ON DELETE SET NULL,
          parent_id uuid REFERENCES cms_entries (id) ON DELETE SET NULL,
          position integer NOT NULL DEFAULT 0,
          published_at timestamptz,
          trashed_from text CHECK (trashed_from IN ('draft', 'pending', 'published', 'private')),
          trashed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK ((status = 'trash') = (trashed_from IS NOT NULL AND trashed_at IS NOT NULL)),
          CHECK (status NOT IN ('published', 'private') OR slug <> ''),
          CHECK (parent_id <> id)
        )
      `)
      // Published and private entries own their slugs, among their siblings for hierarchical
      // types (others have no parent), as wp_unique_post_slug() makes them.
      await db.execute(sql`
        CREATE UNIQUE INDEX cms_entries_slug_key ON cms_entries
          (type, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'), slug)
          WHERE status IN ('published', 'private')
      `)
      // Lists: a type's entries by status, newest first by WordPress's post date.
      await db.execute(sql`
        CREATE INDEX cms_entries_type_date_idx ON cms_entries
          (type, status, (coalesce(published_at, created_at)) DESC, id)
      `)
      await db.execute(sql`CREATE INDEX cms_entries_author_id_idx ON cms_entries (author_id)`)
      await db.execute(sql`CREATE INDEX cms_entries_parent_id_idx ON cms_entries (parent_id)`)
    },
  },
  {
    id: '0003_terms',
    up: async (db) => {
      await db.execute(sql`
        CREATE TABLE cms_terms (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          taxonomy text NOT NULL,
          name text NOT NULL CHECK (name <> ''),
          slug text NOT NULL CHECK (slug <> ''),
          description text NOT NULL DEFAULT '',
          parent_id uuid REFERENCES cms_terms (id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT cms_terms_slug_key UNIQUE (taxonomy, slug),
          CHECK (parent_id <> id)
        )
      `)
      // WordPress refuses a second term of the same name beside another.
      await db.execute(sql`
        CREATE UNIQUE INDEX cms_terms_name_key ON cms_terms
          (taxonomy, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'), lower(name))
      `)
      await db.execute(sql`CREATE INDEX cms_terms_parent_id_idx ON cms_terms (parent_id)`)
      await db.execute(sql`
        CREATE TABLE cms_entry_terms (
          entry_id uuid NOT NULL REFERENCES cms_entries (id) ON DELETE CASCADE,
          term_id uuid NOT NULL REFERENCES cms_terms (id) ON DELETE CASCADE,
          PRIMARY KEY (entry_id, term_id)
        )
      `)
      await db.execute(
        sql`CREATE INDEX cms_entry_terms_term_id_idx ON cms_entry_terms (term_id, entry_id)`,
      )
    },
  },
  {
    id: '0004_entry_meta',
    up: async (db) => {
      // Custom fields beside the entry, one object, not a row per key as wp_postmeta keeps them.
      await db.execute(sql`
        ALTER TABLE cms_entries
          ADD COLUMN meta jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object')
      `)
      // Answers list({ meta: { key: value } }) with jsonb containment.
      await db.execute(
        sql`CREATE INDEX cms_entries_meta_idx ON cms_entries USING gin (meta jsonb_path_ops)`,
      )
    },
  },
]
