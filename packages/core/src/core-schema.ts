import type { Block, EntryStatus } from '@otw/sdk'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

// Core's own tables. Plugins may reference cms_users from their tables; the rest is internal.

export const users = pgTable('cms_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stored lowercase. */
  email: text('email').notNull().unique(),
  name: text('name').notNull().default(''),
  role: text('role').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sessions = pgTable(
  'cms_sessions',
  {
    /** SHA-256 of the cookie token, so a database leak doesn't hand out live sessions. */
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('cms_sessions_user_id_idx').on(table.userId)],
)

export const loginFailures = pgTable(
  'cms_login_failures',
  {
    email: text('email').notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('cms_login_failures_email_idx').on(table.email, table.failedAt)],
)

export const pluginStates = pgTable('cms_plugins', {
  id: text('id').primaryKey(),
  active: boolean('active').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const storedSettings = pgTable('cms_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<string | boolean>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const options = pgTable('cms_options', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

/**
 * Every content type's entries, like WordPress's `wp_posts`. The migration adds what Drizzle
 * doesn't need to know: the checks, and the indexes on expressions.
 */
export const entries = pgTable('cms_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  status: text('status').$type<EntryStatus>().notNull(),
  slug: text('slug').notNull().default(''),
  title: text('title').notNull().default(''),
  body: jsonb('body').$type<Block[]>().notNull().default([]),
  excerpt: text('excerpt').notNull().default(''),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => entries.id, { onDelete: 'set null' }),
  position: integer('position').notNull().default(0),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  trashedFrom: text('trashed_from').$type<Exclude<EntryStatus, 'trash'>>(),
  trashedAt: timestamp('trashed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
