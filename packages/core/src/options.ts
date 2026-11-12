import { randomBytes } from 'node:crypto'
import type { Database } from '@otwdesign/sdk'
import { eq, inArray, sql } from 'drizzle-orm'
import { options } from './core-schema'

const GENERATION = 'core.generation'
const SECRET = 'core.secret'
const WEBHOOK_TOPICS = 'core.webhook_topics'
const PLUGINS_INITIALIZED = 'core.plugins_initialized'

/** The active webhooks' ids by the event each is sent. */
export type WebhookTopics = Record<string, string[]>

/**
 * What a booting kernel reads first: the generation, and with it, in the same query, who is told
 * of which event. The webhooks' own table is read only when one changes.
 */
export async function readBootState(
  db: Database,
): Promise<{ generation: number; webhookTopics: WebhookTopics; pluginsInitialized: boolean }> {
  const rows = await db
    .select()
    .from(options)
    .where(inArray(options.key, [GENERATION, WEBHOOK_TOPICS, PLUGINS_INITIALIZED]))
  const value = (key: string) => rows.find((row) => row.key === key)?.value
  return {
    generation: Number(value(GENERATION) ?? 0),
    webhookTopics: JSON.parse(value(WEBHOOK_TOPICS) ?? '{}') as WebhookTopics,
    pluginsInitialized: value(PLUGINS_INITIALIZED) !== undefined,
  }
}

/**
 * Records that the site has had its first boot, when every installed plugin starts active.
 * True when this call is the one that recorded it: the first boot is now.
 */
export async function markPluginsInitialized(db: Database): Promise<boolean> {
  const marked = await db
    .insert(options)
    .values({ key: PLUGINS_INITIALIZED, value: '1' })
    .onConflictDoNothing()
    .returning({ key: options.key })
  return marked.length > 0
}

/** Keeps `readBootState()`'s copy of the subscriptions, after a webhook changed. */
export async function saveWebhookTopics(db: Database, topics: WebhookTopics): Promise<void> {
  const value = JSON.stringify(topics)
  await db
    .insert(options)
    .values({ key: WEBHOOK_TOPICS, value })
    .onConflictDoUpdate({ target: options.key, set: { value } })
}

/** Bumped whenever activation or settings change, so every running kernel knows to reboot. */
export async function readGeneration(db: Database): Promise<number> {
  const [row] = await db.select().from(options).where(eq(options.key, GENERATION))
  return row ? Number(row.value) : 0
}

export async function bumpGeneration(db: Database): Promise<void> {
  await db
    .insert(options)
    .values({ key: GENERATION, value: '1' })
    .onConflictDoUpdate({
      target: options.key,
      set: { value: sql`(${options.value}::bigint + 1)::text` },
    })
}

/** A per-site signing secret, created on first boot. */
export async function ensureSecret(db: Database): Promise<string> {
  await db
    .insert(options)
    .values({ key: SECRET, value: randomBytes(32).toString('base64url') })
    .onConflictDoNothing()
  const [row] = await db.select().from(options).where(eq(options.key, SECRET))
  return row!.value
}
