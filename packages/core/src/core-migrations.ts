import type { Migration } from '@otwdesign/sdk'
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
  {
    id: '0005_revisions',
    up: async (db) => {
      // Revisions apart from entries, unlike WordPress's in wp_posts: lists never wade through them.
      await db.execute(sql`
        CREATE TABLE cms_revisions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          entry_id uuid NOT NULL REFERENCES cms_entries (id) ON DELETE CASCADE,
          author_id uuid REFERENCES cms_users (id) ON DELETE SET NULL,
          title text NOT NULL,
          body jsonb NOT NULL,
          excerpt text NOT NULL,
          meta jsonb NOT NULL DEFAULT '{}',
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`
        CREATE INDEX cms_revisions_entry_idx ON cms_revisions (entry_id, created_at DESC, id DESC)
      `)
    },
  },
  {
    id: '0006_media',
    up: async (db) => {
      await db.execute(sql`
        CREATE TABLE cms_media (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          author_id uuid REFERENCES cms_users (id) ON DELETE SET NULL,
          entry_id uuid REFERENCES cms_entries (id) ON DELETE SET NULL,
          file text NOT NULL UNIQUE,
          original_file text,
          filename text NOT NULL,
          mime_type text NOT NULL,
          size bigint NOT NULL,
          width integer,
          height integer,
          sizes jsonb NOT NULL DEFAULT '{}',
          title text NOT NULL DEFAULT '',
          alt text NOT NULL DEFAULT '',
          caption text NOT NULL DEFAULT '',
          description text NOT NULL DEFAULT '',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(
        sql`CREATE INDEX cms_media_created_idx ON cms_media (created_at DESC, id DESC)`,
      )
      // Filters by type match a prefix (image/) or a list; text_pattern_ops serves LIKE 'image/%'.
      await db.execute(
        sql`CREATE INDEX cms_media_mime_idx ON cms_media (mime_type text_pattern_ops)`,
      )
      await db.execute(sql`CREATE INDEX cms_media_entry_idx ON cms_media (entry_id)`)
      await db.execute(sql`CREATE INDEX cms_media_author_idx ON cms_media (author_id)`)
    },
  },
  {
    id: '0007_featured_images',
    up: async (db) => {
      // WordPress keeps _thumbnail_id in post meta; a column lets the image's delete clear it.
      await db.execute(sql`
        ALTER TABLE cms_entries
          ADD COLUMN thumbnail_id uuid REFERENCES cms_media (id) ON DELETE SET NULL
      `)
      // Deleting a file looks up the entries that feature it.
      await db.execute(sql`
        CREATE INDEX cms_entries_thumbnail_idx ON cms_entries (thumbnail_id)
          WHERE thumbnail_id IS NOT NULL
      `)
    },
  },
  {
    id: '0008_accounts',
    up: async (db) => {
      await db.execute(sql`ALTER TABLE cms_users ADD COLUMN email_verified_at timestamptz`)
      await db.execute(sql`
        CREATE TABLE cms_user_tokens (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES cms_users (id) ON DELETE CASCADE,
          purpose text NOT NULL CHECK (purpose IN ('password', 'email')),
          token_hash text NOT NULL UNIQUE,
          new_email text,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await db.execute(sql`
        CREATE INDEX cms_user_tokens_user_idx ON cms_user_tokens (user_id, created_at)
      `)
    },
  },
  {
    id: '0009_user_meta',
    up: async (db) => {
      await db.execute(sql`ALTER TABLE cms_users ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'`)
    },
  },
  {
    id: '0010_entry_search',
    up: async (db) => {
      // The admin's search: each entry's words, worked out when it's written. Stored, so a
      // search never re-reads entries' text, whichever plan Postgres picks: with the query's
      // values as parameters it can't tell how many match, and may walk entries by date. Not in
      // the Drizzle schema, so it never shows in entries.
      await db.execute(sql`
        ALTER TABLE cms_entries ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
          to_tsvector('simple', title || ' ' || excerpt || ' '
            || jsonb_path_query_array(body, 'lax $.**.text')::text)
        ) STORED
      `)
      await db.execute(
        sql`CREATE INDEX cms_entries_search_idx ON cms_entries USING gin (search_vector)`,
      )
    },
  },
  {
    id: '0011_entry_counts',
    up: async (db) => {
      // What list screens show above and beside the list: how many entries each status has
      // (everyone's and one author's), and the months for the date filter. Counting them meant
      // reading every entry of the type on every view, so a trigger keeps the totals instead,
      // as WordPress caches wp_count_posts(). A trigger, so writes from anywhere keep them
      // right, a foreign key's included. Rows that reach zero stay, at zero.
      await db.execute(sql`
        CREATE TABLE cms_entry_counts (
          type text NOT NULL,
          status text NOT NULL,
          author_id uuid,
          entries integer NOT NULL
        )
      `)
      await db.execute(sql`
        CREATE UNIQUE INDEX cms_entry_counts_key ON cms_entry_counts
          (type, status, COALESCE(author_id, '00000000-0000-0000-0000-000000000000'::uuid))
      `)
      await db.execute(sql`
        CREATE TABLE cms_entry_months (
          type text NOT NULL,
          status text NOT NULL,
          month date NOT NULL,
          entries integer NOT NULL,
          PRIMARY KEY (type, status, month)
        )
      `)
      // The month as the list's date filter takes it: published, or created, in UTC.
      await db.execute(sql`
        CREATE FUNCTION cms_entry_month(published timestamptz, created timestamptz) RETURNS date
          LANGUAGE sql IMMUTABLE
          RETURN date_trunc('month', COALESCE(published, created) AT TIME ZONE 'UTC')::date
      `)
      await db.execute(sql`
        CREATE FUNCTION cms_entry_counts_change() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
          counted boolean := TG_OP = 'UPDATE' AND OLD.type = NEW.type AND OLD.status = NEW.status
            AND OLD.author_id IS NOT DISTINCT FROM NEW.author_id;
          dated boolean := TG_OP = 'UPDATE' AND OLD.type = NEW.type AND OLD.status = NEW.status
            AND cms_entry_month(OLD.published_at, OLD.created_at)
              = cms_entry_month(NEW.published_at, NEW.created_at);
        BEGIN
          IF TG_OP <> 'INSERT' AND NOT counted THEN
            UPDATE cms_entry_counts SET entries = entries - 1
             WHERE type = OLD.type AND status = OLD.status
               AND author_id IS NOT DISTINCT FROM OLD.author_id;
          END IF;
          IF TG_OP <> 'INSERT' AND NOT dated THEN
            UPDATE cms_entry_months SET entries = entries - 1
             WHERE type = OLD.type AND status = OLD.status
               AND month = cms_entry_month(OLD.published_at, OLD.created_at);
          END IF;
          IF TG_OP <> 'DELETE' AND NOT counted THEN
            INSERT INTO cms_entry_counts AS c VALUES (NEW.type, NEW.status, NEW.author_id, 1)
              ON CONFLICT (type, status, (COALESCE(author_id, '00000000-0000-0000-0000-000000000000'::uuid)))
              DO UPDATE SET entries = c.entries + 1;
          END IF;
          IF TG_OP <> 'DELETE' AND NOT dated THEN
            INSERT INTO cms_entry_months AS m
              VALUES (NEW.type, NEW.status, cms_entry_month(NEW.published_at, NEW.created_at), 1)
              ON CONFLICT (type, status, month) DO UPDATE SET entries = m.entries + 1;
          END IF;
          RETURN NULL;
        END
        $$
      `)
      await db.execute(sql`
        CREATE TRIGGER cms_entry_counts AFTER INSERT OR DELETE
          OR UPDATE OF type, status, author_id, published_at, created_at ON cms_entries
          FOR EACH ROW EXECUTE FUNCTION cms_entry_counts_change()
      `)
      await db.execute(sql`
        INSERT INTO cms_entry_counts
        SELECT type, status, author_id, count(*) FROM cms_entries GROUP BY 1, 2, 3
      `)
      await db.execute(sql`
        INSERT INTO cms_entry_months
        SELECT type, status, cms_entry_month(published_at, created_at), count(*)
          FROM cms_entries GROUP BY 1, 2, 3
      `)
    },
  },
  {
    // The job queue: one row per run, waiting, running or finished.
    id: '0012_jobs',
    up: async (db) => {
      await db.execute(sql`
        CREATE TABLE cms_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL,
          args jsonb NOT NULL DEFAULT '{}',
          unique_key text,
          status text NOT NULL DEFAULT 'pending',
          run_at timestamptz NOT NULL DEFAULT now(),
          attempts integer NOT NULL DEFAULT 0,
          every_seconds integer,
          locked_until timestamptz,
          last_error text,
          created_at timestamptz NOT NULL DEFAULT now(),
          started_at timestamptz,
          finished_at timestamptz
        )
      `)
      await db.execute(sql`CREATE INDEX cms_jobs_status_idx ON cms_jobs (status, run_at)`)
      await db.execute(sql`
        CREATE UNIQUE INDEX cms_jobs_unique_idx ON cms_jobs (name, unique_key)
          WHERE unique_key IS NOT NULL AND status = 'pending'
      `)
    },
  },
  {
    // Scheduled entries, WordPress's `future`: a status of their own, which the trash remembers,
    // and which owns its slug as published and private entries do (wp_unique_post_slug()).
    id: '0013_scheduled_entries',
    up: async (db) => {
      await db.execute(sql`
        ALTER TABLE cms_entries
          DROP CONSTRAINT cms_entries_status_check,
          DROP CONSTRAINT cms_entries_trashed_from_check,
          DROP CONSTRAINT cms_entries_check1,
          ADD CONSTRAINT cms_entries_status_check CHECK
            (status IN ('draft', 'pending', 'scheduled', 'published', 'private', 'trash')),
          ADD CONSTRAINT cms_entries_trashed_from_check CHECK
            (trashed_from IN ('draft', 'pending', 'scheduled', 'published', 'private')),
          ADD CONSTRAINT cms_entries_check1 CHECK
            (status NOT IN ('scheduled', 'published', 'private') OR slug <> '')
      `)
      await db.execute(sql`DROP INDEX cms_entries_slug_key`)
      await db.execute(sql`
        CREATE UNIQUE INDEX cms_entries_slug_key ON cms_entries
          (type, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'), slug)
          WHERE status IN ('scheduled', 'published', 'private')
      `)
      // The planner takes a new index for cheaper than it is until the table is analyzed: on a
      // site with 1,500 posts, counting each category's posts for the Posts list's filter went
      // from 2.5 ms to 6 ms. The embedded database analyzes only after enough rows change.
      await db.execute(sql`ANALYZE cms_entries`)
    },
  },
  {
    // Webhooks: where the site sends its events. Their deliveries wait in cms_jobs.
    id: '0014_webhooks',
    up: async (db) => {
      await db.execute(sql`
        CREATE TABLE cms_webhooks (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL,
          url text NOT NULL,
          topics jsonb NOT NULL DEFAULT '[]',
          status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
          secret text NOT NULL,
          failures integer NOT NULL DEFAULT 0,
          last_delivery_at timestamptz,
          last_result text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `)
    },
  },
]
