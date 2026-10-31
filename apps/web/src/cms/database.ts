import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Database } from '@cms/sdk'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { Pool } from 'pg'
import type { Env } from '@cms/core'

export interface DatabaseHandle {
  db: Database
  close(): Promise<void>
}

export const DEFAULT_DATA_DIR = '.data/pglite'

export function dataDir(env: Env = process.env): string {
  // Runtime data, not a build input: keep the bundler from tracing the whole project.
  return resolve(/* turbopackIgnore: true */ env.CMS_DATA_DIR || DEFAULT_DATA_DIR)
}

/** Postgres when DATABASE_URL is set; otherwise embedded PGlite, so a fresh clone runs with no setup. */
export function openDatabase(env: Env = process.env): DatabaseHandle {
  if (env.DATABASE_URL) {
    const pool = new Pool({ connectionString: env.DATABASE_URL })
    return { db: drizzlePostgres(pool), close: () => pool.end() }
  }
  const dir = dataDir(env)
  // PGlite creates the data directory itself but not its parents (.data/ on a fresh clone).
  mkdirSync(dir, { recursive: true })
  const client = new PGlite(dir)
  return { db: drizzlePglite(client), close: () => client.close() }
}
