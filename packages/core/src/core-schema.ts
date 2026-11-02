import type { Block, EntryMetaValues, EntryStatus } from '@otw/sdk'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
  /** Empty until the person sets one, from the link sign-up emails them. */
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** When the person proved they read this address, by using a link sent to it. */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
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
  thumbnailId: uuid('thumbnail_id').references((): AnyPgColumn => media.id, {
    onDelete: 'set null',
  }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  trashedFrom: text('trashed_from').$type<Exclude<EntryStatus, 'trash'>>(),
  trashedAt: timestamp('trashed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  meta: jsonb('meta').$type<EntryMetaValues>().notNull().default({}),
})

/** Every taxonomy's terms, like WordPress's `wp_terms` and `wp_term_taxonomy` in one. */
export const terms = pgTable('cms_terms', {
  id: uuid('id').primaryKey().defaultRandom(),
  taxonomy: text('taxonomy').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description').notNull().default(''),
  parentId: uuid('parent_id').references((): AnyPgColumn => terms.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Which entries have which terms, like WordPress's `wp_term_relationships`. */
export const entryTerms = pgTable(
  'cms_entry_terms',
  {
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    termId: uuid('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.termId] }),
    index('cms_entry_terms_term_id_idx').on(table.termId, table.entryId),
  ],
)

/** What entries were at each save, like WordPress's revisions, which it keeps as posts. */
export const revisions = pgTable(
  'cms_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    body: jsonb('body').$type<Block[]>().notNull(),
    excerpt: text('excerpt').notNull(),
    meta: jsonb('meta').$type<EntryMetaValues>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('cms_revisions_entry_idx').on(table.entryId, table.createdAt, table.id)],
)

/** One of an image's sizes as stored; its address comes from the storage when it's read. */
export interface StoredMediaSize {
  file: string
  width: number
  height: number
  mimeType: string
  size: number
}

/**
 * The media library, like WordPress's attachments, apart from entries: lists of posts never
 * wade through files, and files have no statuses, slugs or bodies.
 */
export const media = pgTable(
  'cms_media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'set null' }),
    file: text('file').notNull().unique(),
    originalFile: text('original_file'),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    sizes: jsonb('sizes').$type<Record<string, StoredMediaSize>>().notNull().default({}),
    title: text('title').notNull().default(''),
    alt: text('alt').notNull().default(''),
    caption: text('caption').notNull().default(''),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('cms_media_created_idx').on(table.createdAt, table.id),
    index('cms_media_entry_idx').on(table.entryId),
    index('cms_media_author_idx').on(table.authorId),
  ],
)

/** What a token in an emailed link is for: setting a password, or confirming a new address. */
export type UserTokenPurpose = 'password' | 'email'

/**
 * Links sent by email, like WordPress's `user_activation_key`: kept hashed, used once, and only
 * until they expire.
 */
export const userTokens = pgTable(
  'cms_user_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').$type<UserTokenPurpose>().notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** For `email`: the address being confirmed. */
    newEmail: text('new_email'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('cms_user_tokens_user_idx').on(table.userId, table.createdAt)],
)
