import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Database } from '@otwdesign/sdk'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { Pool, type PoolClient } from 'pg'
import { traceQueries, type Env } from '@otwdesign/core'

/** An open database and how to close it. */
export interface DatabaseHandle {
  db: Database
  close(): Promise<void>
}

/** Where the embedded database lives when `CMS_DATA_DIR` isn't set, relative to the site. */
export const DEFAULT_DATA_DIR = '.data/pglite'

/** The embedded database's directory: `CMS_DATA_DIR`, or `DEFAULT_DATA_DIR`, made absolute. */
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
    const pool = tracedPool(new Pool({ connectionString: env.DATABASE_URL }))
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
  const client = tracedPglite(new PGlite(dir))
  return {
    db: drizzlePglite(client),
    close: async () => {
      await client.close()
      release()
    },
  }
}

// Queries are recorded in the current request's trace when it's being traced; see traceQueries.

/** PGlite runs a transaction's queries through the object it hands the callback. */
export function tracedPglite(client: PGlite): PGlite {
  traceQueries(client)
  const transaction = client.transaction.bind(client)
  client.transaction = ((fn: Parameters<PGlite['transaction']>[0]) =>
    transaction((tx) => fn(traceQueries(tx)))) as PGlite['transaction']
  return client
}

const TRACED = Symbol('otw.traced')

/** pg runs transactions on a client checked out of the pool, and reuses those clients. */
function tracedPool(pool: Pool): Pool {
  traceQueries(pool)
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<PoolClient>
  pool.connect = ((...args: unknown[]) => {
    // pg's callback form: left untraced.
    if (args.length > 0) return connect(...args)
    return connect().then((client) => {
      const marked = client as PoolClient & { [TRACED]?: true }
      if (!marked[TRACED]) {
        traceQueries(marked)
        marked[TRACED] = true
      }
      return client
    })
  }) as Pool['connect']
  return pool
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
