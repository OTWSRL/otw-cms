import { randomBytes } from 'node:crypto'
import type { Database } from '@otw/sdk'
import { eq, sql } from 'drizzle-orm'
import { options } from './core-schema'

const GENERATION = 'core.generation'
const SECRET = 'core.secret'

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
