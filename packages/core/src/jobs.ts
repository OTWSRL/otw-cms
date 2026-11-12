import { createHash, timingSafeEqual } from 'node:crypto'
import type {
  ApiHandler,
  EnqueueOptions,
  JobDefinition,
  JobRun,
  JobStatus,
  Logger,
} from '@otwdesign/sdk'
import { and, asc, count, desc, eq, inArray, lte, min, sql, type SQL } from 'drizzle-orm'
import { jobs } from './core-schema'
import type { DatabaseContext } from './database'
import type { HookBus } from './hooks'

/** `core.empty_trash`, `commerce.send-receipt`: the owner's id, a dot, then the job's own name. */
const NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$/
const MAX_NAME = 100
const MAX_KEY = 200
const MAX_ARGS_BYTES = 64 * 1024
const MAX_ERROR = 2000
const MIN_EVERY = 60
const MAX_ATTEMPTS = 20
const DEFAULT_TIMEOUT = 300
const MAX_TIMEOUT = 3600
/** After a run's timeout, how long until another server may take the job over. */
const LOCK_GRACE = 60
const DAY = 24 * 60 * 60
/** The key of a repeating job's waiting run: one per name. */
const REPEAT = '@every'
/** How long one call to `runDue()` keeps starting jobs, unless told otherwise. */
const DEFAULT_BUDGET_MS = 25_000

type AnyDefinition = JobDefinition<Record<string, unknown>>

interface DefinedJob {
  pluginId: string
  name: string
  label: string
  handler: AnyDefinition['handler']
  everySeconds: number | null
  attempts: number
  timeoutSeconds: number
  backoffSeconds(attempt: number): number
}

/** A row of `cms_jobs`, as the admin lists it. */
export interface StoredJob {
  id: string
  name: string
  /** The definition's label, or the name when no active plugin defines it. */
  label: string
  /** Whether an active plugin defines it: a job without a definition waits. */
  defined: boolean
  args: Record<string, unknown>
  status: JobStatus
  runAt: Date
  attempts: number
  everySeconds: number | null
  lastError: string | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

export interface JobListFilter {
  status?: JobStatus
  /** Part of a name. */
  search?: string
  page?: number
  perPage?: number
}

export interface JobService {
  enqueue(
    name: string,
    args: Record<string, unknown>,
    options?: EnqueueOptions,
  ): Promise<string | null>
  cancel(name: string, unique?: string): Promise<number>
  next(name: string, unique?: string): Promise<Date | null>
  /**
   * Runs the jobs that are due, one after another, until none is left or `budgetMs` has passed,
   * and says when the next one is due. What a runner calls: a timer, a cron request.
   */
  runDue(options?: { budgetMs?: number; limit?: number }): Promise<{
    ran: number
    nextDue: Date | null
  }>
  /** When the next job is due, without running anything; `null` when nothing waits. */
  nextDue(): Promise<Date | null>
  /** For Tools › Scheduled Actions. */
  list(filter?: JobListFilter): Promise<{ jobs: StoredJob[]; total: number }>
  counts(): Promise<Record<JobStatus, number>>
  /** Makes a waiting or failed job due now. False when it isn't one of those. */
  runNow(id: string): Promise<boolean>
  /** Cancels a waiting job. False when it isn't waiting. */
  cancelOne(id: string): Promise<boolean>
  /** Deletes finished jobs older than `days`, and returns how many. */
  prune(days: number): Promise<number>
}

function defaultBackoff(attempt: number): number {
  return Math.min(60 * 4 ** (attempt - 1), DAY)
}

function wholeNumber(value: unknown, least: number, most: number): value is number {
  return Number.isInteger(value) && (value as number) >= least && (value as number) <= most
}

/** The jobs plugins define in `setup()`. */
export class JobStore {
  readonly #jobs = new Map<string, DefinedJob>()
  readonly #assertOpen: (what: string) => void

  constructor(assertOpen: (what: string) => void) {
    this.#assertOpen = assertOpen
  }

  define(pluginId: string, name: string, definition: AnyDefinition): void {
    this.#assertOpen(`job "${name}"`)
    const fail = (problem: string): never => {
      throw new Error(`Job "${name}" from "${pluginId}" ${problem}`)
    }
    if (typeof name !== 'string' || !NAME.test(name) || name.length > MAX_NAME) {
      fail('needs a name such as "shop.send-receipt"')
    }
    if (!name.startsWith(`${pluginId}.`)) fail(`must start with "${pluginId}."`)
    const existing = this.#jobs.get(name)
    if (existing) fail(`is already defined by "${existing.pluginId}"`)
    if (!definition || typeof definition.handler !== 'function') fail('needs a handler')
    const { everySeconds, attempts = 1, timeoutSeconds = DEFAULT_TIMEOUT } = definition
    if (everySeconds !== undefined && !wholeNumber(everySeconds, MIN_EVERY, 366 * DAY)) {
      fail(`can repeat every ${MIN_EVERY} seconds or more, as a whole number`)
    }
    if (!wholeNumber(attempts, 1, MAX_ATTEMPTS)) fail(`can be tried 1 to ${MAX_ATTEMPTS} times`)
    if (!wholeNumber(timeoutSeconds, 1, MAX_TIMEOUT)) {
      fail(`can run for 1 to ${MAX_TIMEOUT} seconds`)
    }
    const { backoffSeconds } = definition
    if (
      backoffSeconds !== undefined &&
      typeof backoffSeconds !== 'function' &&
      !wholeNumber(backoffSeconds, 0, 30 * DAY)
    ) {
      fail('needs its backoff as a whole number of seconds, or a function')
    }
    this.#jobs.set(name, {
      pluginId,
      name,
      label: definition.label ?? name,
      handler: definition.handler,
      everySeconds: everySeconds ?? null,
      attempts,
      timeoutSeconds,
      backoffSeconds:
        typeof backoffSeconds === 'function'
          ? backoffSeconds
          : backoffSeconds === undefined
            ? defaultBackoff
            : () => backoffSeconds,
    })
  }

  get(name: string): DefinedJob | undefined {
    return this.#jobs.get(name)
  }

  all(): DefinedJob[] {
    return [...this.#jobs.values()]
  }
}

export interface JobServiceOptions {
  db: DatabaseContext
  logger: Logger
  hooks: HookBus
  store: JobStore
  /**
   * Told when a job has been queued and its transaction committed, with the time it's due, so
   * the app can wake whatever runs jobs.
   */
  onQueued?: (dueAt: Date) => void
}

function invalid(message: string): never {
  throw new TypeError(message)
}

/** The arguments as they'll be stored: plain data, an object, and not too much of it. */
function plainArgs(name: string, args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    invalid(`Job "${name}" takes its arguments as an object`)
  }
  let json: string
  try {
    json = JSON.stringify(args)
  } catch {
    invalid(`Job "${name}" needs arguments that are plain data`)
  }
  if (Buffer.byteLength(json) > MAX_ARGS_BYTES) {
    invalid(`Job "${name}" has more than 64 KB of arguments: pass an id, and read the rest`)
  }
  return JSON.parse(json) as Record<string, unknown>
}

function uniqueKey(name: string, key: string | undefined): string | null {
  if (key === undefined) return null
  if (typeof key !== 'string' || key === '' || key.length > MAX_KEY || key.startsWith('@')) {
    invalid(`Job "${name}" needs a unique key of 1 to ${MAX_KEY} characters, not starting with @`)
  }
  return key
}

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message || error.name : String(error)
  return text.slice(0, MAX_ERROR)
}

/** `cms.jobs` and what runs it: the queue in `cms_jobs`, like Action Scheduler's. */
export function createJobService(options: JobServiceOptions): JobService {
  const { db, logger, hooks, store } = options
  const names = () => store.all().map((job) => job.name)
  const need = (name: string): DefinedJob =>
    store.get(name) ?? invalid(`No active plugin defines the job "${name}"`)

  const waiting = (name: string, unique: string | undefined): SQL => {
    const key = uniqueKey(name, unique)
    const named = and(eq(jobs.status, 'pending'), eq(jobs.name, name))
    return (key === null ? named : and(named, eq(jobs.uniqueKey, key))) as SQL
  }

  /** The next run of a repeating job: the first slot after now, keeping to its rhythm. */
  const nextSlot = (every: number) =>
    sql`${jobs.runAt} + make_interval(secs => ${every}::int * (floor(extract(epoch FROM (now() - ${jobs.runAt})) / ${every}::int) + 1))`

  /**
   * Makes the waiting runs of repeating jobs match what the plugins define now: added, their
   * interval changed, or no longer repeating. One read when nothing changed.
   */
  const syncRepeats = async (): Promise<void> => {
    const defined = store.all()
    const wanted = new Map(
      defined.flatMap((job) => (job.everySeconds ? [[job.name, job.everySeconds] as const] : [])),
    )
    const rows = await db.root
      .select({ name: jobs.name, everySeconds: jobs.everySeconds })
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), eq(jobs.uniqueKey, REPEAT)))
    const stored = new Map(rows.map((row) => [row.name, row.everySeconds]))
    // A job no active plugin defines keeps its row: its plugin may come back.
    const stopped = rows.filter((row) => store.get(row.name) && !wanted.has(row.name))
    const changed = [...wanted].filter(([name, every]) => stored.get(name) !== every)
    if (stopped.length === 0 && changed.length === 0) return
    await db.transaction(async (tx) => {
      const gone = [...stopped.map((row) => row.name), ...changed.map(([name]) => name)]
      await tx
        .delete(jobs)
        .where(
          and(eq(jobs.status, 'pending'), eq(jobs.uniqueKey, REPEAT), inArray(jobs.name, gone)),
        )
      if (changed.length === 0) return
      await tx
        .insert(jobs)
        .values(
          changed.map(([name, every]) => ({
            name,
            uniqueKey: REPEAT,
            everySeconds: every,
            runAt: sql`now() + make_interval(secs => ${every}::int)`,
          })),
        )
        .onConflictDoNothing()
    })
  }

  let synced: Promise<void> | undefined
  /** Once per kernel; a failure is tried again by the next call. */
  const ready = (): Promise<void> => {
    synced ??= syncRepeats().catch((error: unknown) => {
      synced = undefined
      throw error
    })
    return synced
  }

  /** Puts back the runs whose server stopped: their lock ran out while they were still running. */
  const recoverStale = () =>
    db.root
      .update(jobs)
      .set({
        status: 'pending',
        lockedUntil: null,
        lastError: 'The server stopped while this job ran',
      })
      .where(and(eq(jobs.status, 'running'), lte(jobs.lockedUntil, sql`now()`)))

  /** Each job's lock in seconds, for the claim: its own timeout and a margin. */
  const locks = (): string =>
    JSON.stringify(
      Object.fromEntries(store.all().map((job) => [job.name, job.timeoutSeconds + LOCK_GRACE])),
    )

  const claim = async (known: string[], lockSeconds: string) => {
    const due = db.root
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.status, 'pending'), lte(jobs.runAt, sql`now()`), inArray(jobs.name, known)),
      )
      .orderBy(asc(jobs.runAt))
      .limit(1)
      // Two servers never take the same job: the second skips the row the first holds.
      .for('update', { skipLocked: true })
    const [job] = await db.root
      .update(jobs)
      .set({
        status: 'running',
        attempts: sql`${jobs.attempts} + 1`,
        startedAt: sql`now()`,
        lockedUntil: sql`now() + make_interval(secs => (${lockSeconds}::jsonb ->> ${jobs.name})::int)`,
      })
      .where(eq(jobs.id, sql`(${due})`))
      .returning()
    return job
  }

  type Claimed = NonNullable<Awaited<ReturnType<typeof claim>>>

  /** Only the run that holds the job may finish it: a run that outlived its lock has lost it. */
  const held = (job: Claimed) =>
    and(eq(jobs.id, job.id), eq(jobs.status, 'running'), eq(jobs.attempts, job.attempts))

  /** Finishes the job and, for one that repeats, queues its next run. */
  const finish = async (
    job: Claimed,
    defined: DefinedJob,
    status: 'done' | 'failed',
    error: string | null,
  ): Promise<void> => {
    const finished = { status, finishedAt: sql`now()`, lockedUntil: null, lastError: error }
    const every = job.uniqueKey === REPEAT ? defined.everySeconds : null
    if (every === null) {
      await db.root.update(jobs).set(finished).where(held(job))
      return
    }
    await db.transaction(async (tx) => {
      const [done] = await tx
        .update(jobs)
        .set(finished)
        .where(held(job))
        .returning({ next: nextSlot(every).mapWith(jobs.runAt) })
      if (!done) return
      await tx
        .insert(jobs)
        .values({ name: job.name, uniqueKey: REPEAT, everySeconds: every, runAt: done.next })
        .onConflictDoNothing()
    })
  }

  const failed = async (job: Claimed, defined: DefinedJob, error: string): Promise<void> => {
    if (job.attempts < defined.attempts) {
      const wait = Math.max(0, Math.round(defined.backoffSeconds(job.attempts)))
      await db.root
        .update(jobs)
        .set({
          status: 'pending',
          runAt: sql`now() + make_interval(secs => ${wait}::int)`,
          lockedUntil: null,
          lastError: error,
        })
        .where(held(job))
      logger.warn('A job failed and will be tried again', {
        job: job.name,
        id: job.id,
        attempt: job.attempts,
        inSeconds: wait,
        error,
      })
      return
    }
    await finish(job, defined, 'failed', error)
    logger.error('A job failed', { job: job.name, id: job.id, attempts: job.attempts, error })
    await hooks.doAction('job.failed', {
      id: job.id,
      name: job.name,
      args: job.args,
      attempts: job.attempts,
      error,
    })
  }

  const run = async (job: Claimed, defined: DefinedJob): Promise<void> => {
    // Taken over from a server that stopped, with no try left.
    if (job.attempts > defined.attempts) {
      await finish(job, defined, 'failed', job.lastError ?? 'The server stopped while this job ran')
      return
    }
    const controller = new AbortController()
    const timedOut = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () =>
        reject(new Error(`It ran longer than its ${defined.timeoutSeconds} seconds`)),
      )
    })
    const timer = setTimeout(() => controller.abort(), defined.timeoutSeconds * 1000)
    const details: JobRun = { id: job.id, attempt: job.attempts, signal: controller.signal }
    try {
      // A handler that ignores the signal goes on by itself; its job is over either way.
      await Promise.race([
        Promise.resolve().then(() => defined.handler(job.args, details)),
        timedOut,
      ])
    } catch (error) {
      await failed(job, defined, reason(error))
      return
    } finally {
      clearTimeout(timer)
    }
    await finish(job, defined, 'done', null)
  }

  const nextDue = async (): Promise<Date | null> => {
    const known = names()
    if (known.length === 0) return null
    await ready()
    // A running job's lock is a time to look again: it's taken over then, if still running.
    const result = await db.root.execute(sql`
      SELECT least(
        (SELECT min(run_at) FROM cms_jobs WHERE status = 'pending' AND ${inArray(jobs.name, known)}),
        (SELECT min(locked_until) FROM cms_jobs WHERE status = 'running')
      ) AS at
    `)
    // node-postgres and PGlite both answer with { rows }; Drizzle's type can't know which.
    const at = (result as unknown as { rows: { at: Date | string | null }[] }).rows[0]?.at ?? null
    return at === null ? null : new Date(at)
  }

  const toStored = (row: typeof jobs.$inferSelect): StoredJob => {
    const defined = store.get(row.name)
    return {
      id: row.id,
      name: row.name,
      label: defined?.label ?? row.name,
      defined: defined !== undefined,
      args: row.args,
      status: row.status,
      runAt: row.runAt,
      attempts: row.attempts,
      everySeconds: row.everySeconds,
      lastError: row.lastError,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    }
  }

  return {
    async enqueue(name, args, enqueueOptions = {}) {
      need(name)
      const { at } = enqueueOptions
      if (at !== undefined && (!(at instanceof Date) || Number.isNaN(at.getTime()))) {
        invalid(`Job "${name}" needs a valid time to run at`)
      }
      const [row] = await db.current
        .insert(jobs)
        .values({
          name,
          args: plainArgs(name, args),
          uniqueKey: uniqueKey(name, enqueueOptions.unique),
          ...(at ? { runAt: at } : {}),
        })
        .onConflictDoNothing()
        .returning({ id: jobs.id, runAt: jobs.runAt })
      if (!row) return null
      await db.afterCommit(async () => {
        try {
          options.onQueued?.(row.runAt)
        } catch (error) {
          // The job is stored; the next look at the queue finds it.
          logger.error('The job runner could not be woken', { job: name, error })
        }
      })
      return row.id
    },

    async cancel(name, unique) {
      const cancelled = await db.current
        .update(jobs)
        .set({ status: 'cancelled', finishedAt: sql`now()` })
        .where(waiting(name, unique))
        .returning({ id: jobs.id })
      return cancelled.length
    },

    async next(name, unique) {
      const [row] = await db.current
        .select({ at: min(jobs.runAt) })
        .from(jobs)
        .where(waiting(name, unique))
      return row?.at ?? null
    },

    async runDue({ budgetMs = DEFAULT_BUDGET_MS, limit = Number.POSITIVE_INFINITY } = {}) {
      const known = names()
      if (known.length === 0) return { ran: 0, nextDue: null }
      await ready()
      await recoverStale()
      const lockSeconds = locks()
      const deadline = Date.now() + budgetMs
      let ran = 0
      while (ran < limit && Date.now() < deadline) {
        const job = await claim(known, lockSeconds)
        if (!job) break
        // Known by name, so defined: the claim only takes those.
        await run(job, store.get(job.name)!)
        ran++
      }
      return { ran, nextDue: await nextDue() }
    },

    nextDue,

    async list({ status, search, page = 1, perPage = 20 } = {}) {
      const conditions: SQL[] = []
      if (status) conditions.push(eq(jobs.status, status))
      if (search)
        conditions.push(sql`${jobs.name} ILIKE ${`%${search.replace(/[\\%_]/g, '\\$&')}%`}`)
      const where = conditions.length > 0 ? and(...conditions) : undefined
      // Waiting jobs soonest first; what has run, latest first.
      const order = status === 'pending' ? asc(jobs.runAt) : desc(jobs.runAt)
      const [rows, [total]] = await Promise.all([
        db.root
          .select()
          .from(jobs)
          .where(where)
          .orderBy(order, asc(jobs.id))
          .limit(perPage)
          .offset((Math.max(1, page) - 1) * perPage),
        db.root.select({ total: count() }).from(jobs).where(where),
      ])
      return { jobs: rows.map(toStored), total: total?.total ?? 0 }
    },

    async counts() {
      const rows = await db.root
        .select({ status: jobs.status, total: count() })
        .from(jobs)
        .groupBy(jobs.status)
      const counts: Record<JobStatus, number> = {
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
      }
      for (const row of rows) counts[row.status] = row.total
      return counts
    },

    async runNow(id) {
      // A failed job starts over with all its tries, as a run of its own: without its key, so
      // it can't collide with the run queued after it.
      const [row] = await db.root
        .update(jobs)
        .set({
          status: 'pending',
          runAt: sql`now()`,
          attempts: 0,
          finishedAt: null,
          uniqueKey: sql`CASE WHEN ${jobs.status} = 'failed' THEN NULL ELSE ${jobs.uniqueKey} END`,
        })
        .where(and(eq(jobs.id, id), inArray(jobs.status, ['pending', 'failed'])))
        .returning({ runAt: jobs.runAt })
      if (!row) return false
      options.onQueued?.(row.runAt)
      return true
    },

    async cancelOne(id) {
      const cancelled = await db.root
        .update(jobs)
        .set({ status: 'cancelled', finishedAt: sql`now()` })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'pending')))
        .returning({ id: jobs.id })
      return cancelled.length > 0
    },

    async prune(days) {
      const deleted = await db.root
        .delete(jobs)
        .where(
          and(
            inArray(jobs.status, ['done', 'failed', 'cancelled']),
            lte(jobs.finishedAt, sql`now() - make_interval(days => ${days}::int)`),
          ),
        )
        .returning({ id: jobs.id })
      return deleted.length
    },
  }
}

/** How long one cron request keeps starting jobs: well inside a serverless function's time. */
const CRON_BUDGET_MS = 20_000

const sameText = (a: string, b: string): boolean =>
  // Hashed first, so the comparison takes as long whatever the lengths.
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

/**
 * `GET /api/p/core/cron`: runs the jobs that are due, for hosts where nothing runs between
 * requests. The caller proves itself with `Authorization: Bearer <CRON_SECRET>`, which Vercel
 * Cron sends by itself; without a `CRON_SECRET` in the environment the route isn't there.
 */
export function cronHandler(options: {
  secret(): string | undefined
  runDue: JobService['runDue']
}): ApiHandler {
  const json = (body: unknown, status: number) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
  return async (request) => {
    const secret = options.secret()
    if (!secret) return json({ error: 'Not found' }, 404)
    const given = request.headers.get('authorization') ?? ''
    if (!sameText(given, `Bearer ${secret}`)) return json({ error: 'Unauthorized' }, 401)
    const { ran, nextDue } = await options.runDue({ budgetMs: CRON_BUDGET_MS })
    return json({ ran, nextDue: nextDue?.toISOString() ?? null }, 200)
  }
}
