import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Database } from '@otw/sdk'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { Pool } from 'pg'
import type { Env } from '@otw/core'

export interface DatabaseHandle {
  db: Database
  close(): Promise<void>
}

export const DEFAULT_DATA_DIR = '.data/pglite'

export function dataDir(env: Env = process.env): string {
  // Runtime data, not a build input: keep the bundler from tracing the whole project.
  return resolve(/* turbopackIgnore: true */ env.CMS_DATA_DIR || DEFAULT_DATA_DIR)
}

/**
 * Postgres when DATABASE_URL is set; otherwise embedded PGlite, so a fresh clone runs with no
 * setup. `create: false` is for read-only checks: an embedded database that doesn't exist yet is
 * opened empty, in memory, rather than created on disk.
 */
export function openDatabase(
  env: Env = process.env,
  { create = true }: { create?: boolean } = {},
): DatabaseHandle {
  if (env.DATABASE_URL) {
    const pool = new Pool({ connectionString: env.DATABASE_URL })
    return { db: drizzlePostgres(pool), close: () => pool.end() }
  }
  const dir = dataDir(env)
  if (!create && !existsSync(dir)) {
    const memory = new PGlite()
    return { db: drizzlePglite(memory), close: () => memory.close() }
  }
  const release = claimEmbeddedDatabase(dir)
  // PGlite creates the data directory itself but not its parents (.data/ on a fresh clone).
  mkdirSync(dir, { recursive: true })
  const client = new PGlite(dir)
  return {
    db: drizzlePglite(client),
    close: async () => {
      await client.close()
      release()
    },
  }
}

function lockHolder(file: string): number | undefined {
  const pid = Number.parseInt(existsSync(file) ? readFileSync(file, 'utf8') : '', 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, under another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * PGlite loads its files into one process's memory and doesn't lock them, so a second process
 * (a second server, or `cms migrate` beside a running site) would never see the first's writes
 * and could corrupt them. A lock file with the owner's process id stops that; one left by a
 * process that has exited is taken over.
 */
function claimEmbeddedDatabase(dir: string): () => void {
  const file = `${dir}.lock`
  const holder = lockHolder(file)
  if (holder !== undefined && holder !== process.pid && isRunning(holder)) {
    throw new Error(
      `The embedded database in ${dir} is open in another process (${holder}). Stop that process first: only one can use the embedded database. To share a database between processes, use Postgres (DATABASE_URL).`,
    )
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, String(process.pid))
  return () => {
    if (lockHolder(file) === process.pid) rmSync(file, { force: true })
  }
}
