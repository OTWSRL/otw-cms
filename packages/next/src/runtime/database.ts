import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Database } from '@otwdesign/sdk'
import { PGlite, type PGliteOptions } from '@electric-sql/pglite'
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

/** PostgreSQL's default is 128 MB, which PGlite holds in memory however small the site is. */
export const DEFAULT_SHARED_BUFFERS = '16MB'

const SIZE = /^[1-9]\d*(kB|MB|GB)$/

/**
 * The embedded database's `shared_buffers`: `CMS_SHARED_BUFFERS`, or `DEFAULT_SHARED_BUFFERS`.
 * PGlite keeps the database's files in memory too, so a small cache costs reads little. A large
 * embedded database whose lists and counts slow down can raise it.
 */
export function sharedBuffers(env: Env = process.env): string {
  const value = env.CMS_SHARED_BUFFERS?.trim() || DEFAULT_SHARED_BUFFERS
  if (!SIZE.test(value)) {
    throw new Error(
      `CMS_SHARED_BUFFERS must be a size such as 16MB or 128MB, not "${env.CMS_SHARED_BUFFERS}".`,
    )
  }
  return value
}

/**
 * Postgres when DATABASE_URL is set; otherwise embedded PGlite, so a fresh clone runs with no
 * setup. A new embedded database is created by a process of its own (see
 * `createEmbeddedDatabase`). `create: false` is for read-only checks: an embedded database that
 * doesn't exist yet is opened empty, in memory, rather than created on disk.
 */
export function openDatabase(
  env: Env = process.env,
  { create = true }: { create?: boolean } = {},
): DatabaseHandle {
  if (env.DATABASE_URL) {
    const pool = tracedPool(new Pool({ connectionString: env.DATABASE_URL }))
    return { db: drizzlePostgres(pool), close: () => pool.end() }
  }
  // Parameters given replace PGlite's own, so its defaults come first.
  const options: PGliteOptions = {
    startParams: [...PGlite.defaultStartParams, '-c', `shared_buffers=${sharedBuffers(env)}`],
  }
  const dir = dataDir(env)
  if (!create && !existsSync(dir)) {
    const memory = new PGlite(options)
    return { db: drizzlePglite(memory), close: () => memory.close() }
  }
  const release = claimEmbeddedDatabase(dir)
  // PGlite creates the data directory itself but not its parents (.data/ on a fresh clone).
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, 'PG_VERSION'))) createEmbeddedDatabase(dir)
  const client = tracedPglite(new PGlite(dir, options))
  return {
    db: drizzlePglite(client),
    close: async () => {
      await client.close()
      release()
    },
  }
}

// Run by Node in the site's directory, where the site depends on PGlite: creates the database
// in the directory it's given, then exits. PGlite's ES module, the one the server loads, so a
// standalone build has it too.
const CREATE_DATABASE = `
const { PGlite } = await import('@electric-sql/pglite')
const db = new PGlite(process.argv[1])
await db.waitReady
await db.close()
`

/**
 * Creates a new embedded database in a process of its own. PGlite builds one with a second
 * instance and its initdb module, about 700 MB that a server would keep until it restarts; a
 * process that exits gives it back. It waits, as a first boot waits for its database anyway.
 * If that process can't run, PGlite creates it here, as it would by itself.
 */
function createEmbeddedDatabase(dir: string): void {
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', CREATE_DATABASE, dir], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    console.warn(
      `cms: creating the embedded database in this process, which keeps the memory that takes until it restarts. A separate process couldn't: ${stderr || (error instanceof Error ? error.message : String(error))}`,
    )
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
