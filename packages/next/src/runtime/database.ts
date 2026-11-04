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
 * doesn't exist yet is opened empty, in memory, rather than created on disk. `maintain: true`,
 * for a server, keeps an embedded database's statistics current (see `scheduleMaintenance`).
 */
export function openDatabase(
  env: Env = process.env,
  { create = true, maintain = false }: { create?: boolean; maintain?: boolean } = {},
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
  const stopMaintenance = maintain ? scheduleMaintenance(client) : undefined
  return {
    db: drizzlePglite(client),
    close: async () => {
      stopMaintenance?.()
      await client.close()
      release()
    },
  }
}

/** What one maintenance pass did: the tables it analyzed and those it vacuumed. */
export interface Maintenance {
  analyzed: string[]
  vacuumed: string[]
}

/**
 * Does for the embedded database what autovacuum does for a PostgreSQL server, which PGlite,
 * running no background processes, never does: statistics for each table that changed enough,
 * so the planner knows how many rows there are, and a vacuum for each with enough dead rows or
 * new ones, which index-only scans need. Autovacuum's default thresholds.
 */
export async function maintainEmbeddedDatabase(client: PGlite): Promise<Maintenance> {
  const { rows } = await client.query<{
    name: string
    tuples: number
    live: number
    dead: number
    modified: number
    inserted: number
    analyzed: boolean
  }>(`
    SELECT quote_ident(s.schemaname) || '.' || quote_ident(s.relname) AS name,
           greatest(c.reltuples, 0)::float8 AS tuples,
           s.n_live_tup::float8 AS live, s.n_dead_tup::float8 AS dead,
           s.n_mod_since_analyze::float8 AS modified, s.n_ins_since_vacuum::float8 AS inserted,
           s.last_analyze IS NOT NULL OR s.last_autoanalyze IS NOT NULL AS analyzed
      FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
     ORDER BY 1
  `)
  const done: Maintenance = { analyzed: [], vacuumed: [] }
  for (const table of rows) {
    const analyze = table.modified > 50 + 0.1 * table.tuples || (!table.analyzed && table.live > 0)
    const vacuum =
      table.dead > 50 + 0.2 * table.tuples || table.inserted > 1000 + 0.2 * table.tuples
    if (vacuum) {
      await client.exec(`VACUUM ${analyze ? '(ANALYZE) ' : ''}${table.name}`)
      done.vacuumed.push(table.name)
    } else if (analyze) {
      await client.exec(`ANALYZE ${table.name}`)
    }
    if (analyze) done.analyzed.push(table.name)
  }
  return done
}

/**
 * Runs `maintainEmbeddedDatabase` on a timer: first once a starting server has answered its
 * first requests, then every few minutes. Each pass is quick when nothing changed. Returns a
 * function that stops it; the timer never keeps the process alive.
 */
export function scheduleMaintenance(
  client: PGlite,
  { firstMs = 30_000, everyMs = 5 * 60_000 }: { firstMs?: number; everyMs?: number } = {},
): () => void {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const run = async () => {
    try {
      await maintainEmbeddedDatabase(client)
    } catch (error) {
      console.warn(
        `cms: maintaining the embedded database failed, and is tried again in ${Math.round(everyMs / 1000)} s: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!stopped) timer = setTimeout(run, everyMs).unref()
  }
  timer = setTimeout(run, firstMs).unref()
  return () => {
    stopped = true
    clearTimeout(timer)
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

/** When this process started, in milliseconds since 1970: with its id, it names the lock's owner. */
const STARTED_AT = Math.round(Date.now() - process.uptime() * 1000)

/** Start times a process and the system's record of it may differ by: clock ticks, Node's start. */
const SAME_START_MS = 2000

/** Linux reports process start times in clock ticks of 1/100 s (USER_HZ), on every architecture. */
const TICKS_PER_SECOND = 100

interface LockOwner {
  pid: number
  /** Missing in a lock written before start times were. */
  startedAt?: number
}

function lockOwner(file: string): LockOwner | undefined {
  const [pid, startedAt] = (existsSync(file) ? readFileSync(file, 'utf8') : '')
    .trim()
    .split(/\s+/)
    .map(Number)
  if (!Number.isSafeInteger(pid) || pid! <= 0) return undefined
  return { pid: pid!, startedAt: Number.isFinite(startedAt) ? startedAt : undefined }
}

/** When a running process started, as the system says: /proc on Linux, ps elsewhere. */
function processStartedAt(pid: number): number | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // Field 22, counted after the command's name, which may hold spaces and parentheses.
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
      const bootedAt = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1])
      const started = bootedAt * 1000 + (ticks * 1000) / TICKS_PER_SECOND
      return Number.isFinite(started) ? started : undefined
    }
    const started = Date.parse(
      execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    )
    return Number.isNaN(started) ? undefined : started
  } catch {
    // Exited since, or no way to ask: the caller treats the lock as held, as before.
    return undefined
  }
}

/**
 * Whether the lock's owner is still running. A live process with the owner's id isn't enough:
 * a container that restarts hands out the same low ids again, so the id may now belong to
 * another process. When the system can't say when it started, the lock counts as held.
 */
function ownerRunning(owner: LockOwner): boolean {
  if (owner.pid === process.pid || !isRunning(owner.pid)) return false
  if (owner.startedAt === undefined) return true
  const started = processStartedAt(owner.pid)
  return started === undefined || Math.abs(started - owner.startedAt) < SAME_START_MS
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
 * and could corrupt them. A lock file with the owner's process id and start time stops that;
 * one left by a process that has exited, or whose id another process has since, is taken over.
 */
function claimEmbeddedDatabase(dir: string): () => void {
  const file = `${dir}.lock`
  const owner = lockOwner(file)
  if (owner && ownerRunning(owner)) {
    throw new Error(
      `The embedded database in ${dir} is open in another process (${owner.pid}). Stop that process first: only one can use the embedded database. To share a database between processes, use Postgres (DATABASE_URL).`,
    )
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${process.pid} ${STARTED_AT}`)
  return () => {
    if (lockOwner(file)?.pid === process.pid) rmSync(file, { force: true })
  }
}
