import { randomBytes } from 'node:crypto'
import type { Database } from '@otwdesign/sdk'
import { eq, inArray, sql } from 'drizzle-orm'
import { options } from './core-schema'

const GENERATION = 'core.generation'
const SECRET = 'core.secret'
const WEBHOOK_TOPICS = 'core.webhook_topics'

/** The active webhooks' ids by the event each is sent. */
export type WebhookTopics = Record<string, string[]>

/**
 * What a booting kernel reads first: the generation, and with it, in the same query, who is told
 * of which event. The webhooks' own table is read only when one changes.
 */
export async function readBootState(
  db: Database,
): Promise<{ generation: number; webhookTopics: WebhookTopics }> {
  const rows = await db
    .select()
    .from(options)
    .where(inArray(options.key, [GENERATION, WEBHOOK_TOPICS]))
  const value = (key: string) => rows.find((row) => row.key === key)?.value
  return {
    generation: Number(value(GENERATION) ?? 0),
    webhookTopics: JSON.parse(value(WEBHOOK_TOPICS) ?? '{}') as WebhookTopics,
  }
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
