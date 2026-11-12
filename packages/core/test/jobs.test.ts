import { defineAdmin, type JobDefinition, type JobRun, type PluginContext } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createKernel, type Kernel, type KernelOptions } from '../src/kernel'
import { bootKernel, createDb, memoryLogger, plugin } from './helpers'

declare module '@otwdesign/sdk' {
  interface Jobs {
    'shop.send-receipt': { order: string }
    'shop.flaky': { order: string }
    'shop.slow': Record<string, never>
    'shop.sync-stock': Record<string, never>
    'shop.reindex': Record<string, never>
    'other.thing': Record<string, never>
  }
}

interface Ran {
  args: unknown
  run: Pick<JobRun, 'id' | 'attempt'>
}

/** A shop whose jobs record their runs, and fail when told to. */
function shop(
  definitions: {
    [K in 'send-receipt' | 'flaky' | 'slow' | 'sync-stock' | 'reindex']?: Partial<
      JobDefinition<never>
    >
  } = { 'send-receipt': {} },
) {
  const ran: Ran[] = []
  const state = { fail: 0, cms: undefined as PluginContext | undefined }
  const definition = plugin('shop', {
    setup(cms) {
      state.cms = cms
      for (const [name, extra] of Object.entries(definitions)) {
        cms.jobs.define(
          `shop.${name}` as 'shop.send-receipt',
          {
            handler: async (args: unknown, run: JobRun) => {
              ran.push({ args, run: { id: run.id, attempt: run.attempt } })
              if (state.fail > 0) {
                state.fail--
                throw new Error('The printer is on fire')
              }
            },
            ...extra,
          } as never,
        )
      }
    },
  })
  return { definition, ran, state, cms: () => state.cms! }
}

/** Moves waiting jobs' times into the past, as if that long had gone by. */
const pass = (kernel: Kernel, seconds: number) =>
  kernel.db.execute(sql`
    UPDATE cms_jobs SET run_at = run_at - make_interval(secs => ${seconds}::int)
     WHERE status = 'pending'
  `)

const rows = async (kernel: Kernel) => {
  const { jobs } = await kernel.jobs.list({ perPage: 100 })
  return jobs.map((job) => ({ name: job.name, status: job.status, attempts: job.attempts }))
}

describe('defining jobs', () => {
  const boot = (setup: (cms: PluginContext) => void, id = 'shop') =>
    bootKernel({ plugins: [plugin(id, { setup })] })
  const handler = async () => {}

  it('takes a job named after its plugin, once', async () => {
    await expect(boot((cms) => cms.jobs.define('other.thing', { handler }))).rejects.toThrow(
      'must start with "shop."',
    )
    await expect(
      boot((cms) => cms.jobs.define('Shop Receipt' as never, { handler })),
    ).rejects.toThrow('needs a name such as')
    await expect(
      boot((cms) => {
        cms.jobs.define('shop.send-receipt', { handler })
        cms.jobs.define('shop.send-receipt', { handler })
      }),
    ).rejects.toThrow('is already defined by "shop"')
    await expect(boot((cms) => cms.jobs.define('shop.send-receipt', {} as never))).rejects.toThrow(
      'needs a handler',
    )
  })

  it('checks how often it repeats, how many tries it gets and how long it may run', async () => {
    const define = (extra: Partial<JobDefinition<never>>) =>
      boot((cms) => cms.jobs.define('shop.sync-stock', { handler, ...extra } as never))
    await expect(define({ everySeconds: 30 })).rejects.toThrow('every 60 seconds or more')
    await expect(define({ attempts: 0 })).rejects.toThrow('tried 1 to 20 times')
    await expect(define({ timeoutSeconds: 7200 })).rejects.toThrow('1 to 3600 seconds')
    await expect(define({ backoffSeconds: -1 })).rejects.toThrow('backoff')
  })

  it('belongs in setup(), not the admin entry or later', async () => {
    const definition = plugin('shop')
    await expect(
      bootKernel({
        plugins: [definition],
        admin: [
          defineAdmin(definition, (cms) => cms.jobs.define('shop.send-receipt', { handler })),
        ],
      }),
    ).rejects.toThrow('Define the job "shop.send-receipt" in setup()')

    const { definition: late, cms } = shop()
    await bootKernel({ plugins: [late] })
    expect(() => cms().jobs.define('shop.flaky', { handler })).toThrow('after boot')
  })
})

describe('queueing and running', () => {
  it('runs a queued job with its arguments, and keeps it as done', async () => {
    const { definition, ran, cms } = shop()
    const kernel = await bootKernel({ plugins: [definition] })
    const id = await cms().jobs.enqueue('shop.send-receipt', { order: 'A-1' })

    expect(await kernel.jobs.runDue()).toEqual({ ran: 1, nextDue: null })
    expect(ran).toEqual([{ args: { order: 'A-1' }, run: { id, attempt: 1 } }])
    expect(await rows(kernel)).toEqual([{ name: 'shop.send-receipt', status: 'done', attempts: 1 }])
    // Nothing is left to run.
    expect(await kernel.jobs.runDue()).toEqual({ ran: 0, nextDue: null })
  })

  it('queues with the transaction that asked, and wakes the runner once it commits', async () => {
    const { definition, cms } = shop()
    const woken: Date[] = []
    const kernel = await bootKernel({
      plugins: [definition],
      onJobQueued: (dueAt) => woken.push(dueAt),
    })

    await expect(
      kernel.transaction(async () => {
        await cms().jobs.enqueue('shop.send-receipt', { order: 'lost' })
        throw new Error('The order could not be saved')
      }),
    ).rejects.toThrow('could not be saved')
    expect(woken).toEqual([])
    expect(await rows(kernel)).toEqual([])

    await kernel.transaction(async () => {
      await cms().jobs.enqueue('shop.send-receipt', { order: 'kept' })
      expect(woken).toEqual([])
    })
    expect(woken).toHaveLength(1)
    expect(await rows(kernel)).toHaveLength(1)
  })

  it('waits for a job’s time', async () => {
    const { definition, ran, cms } = shop()
    const kernel = await bootKernel({ plugins: [definition] })
    const at = new Date(Date.now() + 3600_000)
    await cms().jobs.enqueue('shop.send-receipt', { order: 'later' }, { at })

    expect(await kernel.jobs.runDue()).toEqual({ ran: 0, nextDue: at })
    expect(await cms().jobs.next('shop.send-receipt')).toEqual(at)
    await pass(kernel, 3601)
    expect((await kernel.jobs.runDue()).ran).toBe(1)
    expect(ran).toHaveLength(1)
  })

  it('runs the jobs that are due in order of their time, as many as it’s allowed', async () => {
    const { definition, ran, cms } = shop()
    const kernel = await bootKernel({ plugins: [definition] })
    const ago = (seconds: number) => new Date(Date.now() - seconds * 1000)
    await cms().jobs.enqueue('shop.send-receipt', { order: 'second' }, { at: ago(10) })
    await cms().jobs.enqueue('shop.send-receipt', { order: 'first' }, { at: ago(20) })
    await cms().jobs.enqueue('shop.send-receipt', { order: 'third' })

    expect((await kernel.jobs.runDue({ limit: 2 })).ran).toBe(2)
    expect(ran.map((job) => job.args)).toEqual([{ order: 'first' }, { order: 'second' }])
    // No time left: nothing is started.
    expect((await kernel.jobs.runDue({ budgetMs: 0 })).ran).toBe(0)
    expect((await kernel.jobs.runDue()).ran).toBe(1)
  })

  it('queues one waiting job per unique key', async () => {
    const { definition, ran, cms } = shop({ reindex: {} })
    const kernel = await bootKernel({ plugins: [definition] })
    const first = await cms().jobs.enqueue('shop.reindex', {}, { unique: 'catalog' })
    expect(first).toEqual(expect.any(String))
    expect(await cms().jobs.enqueue('shop.reindex', {}, { unique: 'catalog' })).toBeNull()
    expect(await cms().jobs.enqueue('shop.reindex', {}, { unique: 'search' })).not.toBeNull()

    expect((await kernel.jobs.runDue()).ran).toBe(2)
    expect(ran).toHaveLength(2)
    // Once it has run, the key is free again.
    expect(await cms().jobs.enqueue('shop.reindex', {}, { unique: 'catalog' })).not.toBeNull()
  })

  it('cancels waiting jobs, all of a name or those with a key', async () => {
    const { definition, ran, cms } = shop({ reindex: {} })
    const kernel = await bootKernel({ plugins: [definition] })
    await cms().jobs.enqueue('shop.reindex', {}, { unique: 'catalog' })
    await cms().jobs.enqueue('shop.reindex', {}, { unique: 'search' })
    await cms().jobs.enqueue('shop.reindex', {})

    expect(await cms().jobs.cancel('shop.reindex', 'catalog')).toBe(1)
    expect(await cms().jobs.next('shop.reindex', 'catalog')).toBeNull()
    expect(await cms().jobs.cancel('shop.reindex')).toBe(2)
    expect((await kernel.jobs.runDue()).ran).toBe(0)
    expect(ran).toEqual([])
    expect(await kernel.jobs.counts()).toMatchObject({ cancelled: 3, pending: 0 })
  })

  it('refuses a job nobody defines, and arguments that aren’t plain data', async () => {
    const { definition, cms } = shop()
    await bootKernel({ plugins: [definition] })
    await expect(cms().jobs.enqueue('other.thing', {})).rejects.toThrow(
      'No active plugin defines the job "other.thing"',
    )
    const enqueue = (args: unknown, options?: object) =>
      cms().jobs.enqueue('shop.send-receipt', args as never, options)
    await expect(enqueue(['A-1'])).rejects.toThrow('takes its arguments as an object')
    await expect(enqueue({ order: 10n })).rejects.toThrow('plain data')
    await expect(enqueue({ order: 'x'.repeat(70_000) })).rejects.toThrow('64 KB')
    await expect(enqueue({ order: 'A-1' }, { at: new Date('nope') })).rejects.toThrow('valid time')
    await expect(enqueue({ order: 'A-1' }, { unique: '@every' })).rejects.toThrow('unique key')
  })

  it('never runs a job twice when two servers look at once', async () => {
    const db = createDb()
    const first = shop()
    const second = shop()
    const options = (definition: KernelOptions['plugins'][number]): KernelOptions => ({
      db,
      plugins: [definition],
      logger: memoryLogger(),
      strict: true,
      passwordHashing: 'fast',
    })
    const one = await createKernel(options(first.definition))
    const two = await createKernel(options(second.definition))
    for (let order = 0; order < 6; order++) {
      await first.cms().jobs.enqueue('shop.send-receipt', { order: String(order) })
    }

    const [a, b] = await Promise.all([one.jobs.runDue(), two.jobs.runDue()])
    expect(a.ran + b.ran).toBe(6)
    const orders = [...first.ran, ...second.ran].map((job) => (job.args as { order: string }).order)
    expect(orders.sort()).toEqual(['0', '1', '2', '3', '4', '5'])
  })
})

describe('failing', () => {
  it('fails a job with no try left, keeps why, and tells whoever listens', async () => {
    const { definition, state, cms } = shop()
    const told: unknown[] = []
    const listener = plugin('listener', {
      setup: (other) => other.hooks.addAction('job.failed', (payload) => void told.push(payload)),
    })
    const logger = memoryLogger()
    const kernel = await bootKernel({ plugins: [definition, listener], logger })
    const id = await cms().jobs.enqueue('shop.send-receipt', { order: 'A-1' })
    state.fail = 1

    expect((await kernel.jobs.runDue()).ran).toBe(1)
    const { jobs } = await kernel.jobs.list()
    expect(jobs[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'The printer is on fire',
    })
    expect(jobs[0]!.finishedAt).toBeInstanceOf(Date)
    expect(told).toEqual([
      {
        id,
        name: 'shop.send-receipt',
        args: { order: 'A-1' },
        attempts: 1,
        error: 'The printer is on fire',
      },
    ])
    expect(logger.entries.filter((entry) => entry.level === 'error')).toHaveLength(1)
  })

  it('tries again after a wait that grows, as often as the job allows', async () => {
    const { definition, ran, state, cms } = shop({ flaky: { attempts: 3 } })
    const kernel = await bootKernel({ plugins: [definition] })
    await cms().jobs.enqueue('shop.flaky', { order: 'A-1' })
    state.fail = 2

    const first = await kernel.jobs.runDue()
    expect(first.ran).toBe(1)
    // One minute after the first failure, four after the second.
    expect(first.nextDue!.getTime() - Date.now()).toBeGreaterThan(55_000)
    expect(first.nextDue!.getTime() - Date.now()).toBeLessThan(65_000)
    expect(await rows(kernel)).toEqual([{ name: 'shop.flaky', status: 'pending', attempts: 1 }])

    await pass(kernel, 61)
    const second = await kernel.jobs.runDue()
    expect(second.nextDue!.getTime() - Date.now()).toBeGreaterThan(235_000)
    await pass(kernel, 241)
    expect((await kernel.jobs.runDue()).ran).toBe(1)
    expect(ran.map((job) => job.run.attempt)).toEqual([1, 2, 3])
    expect(await rows(kernel)).toEqual([{ name: 'shop.flaky', status: 'done', attempts: 3 }])
  })

  it('stops waiting for a job that runs past its time, and aborts its signal', async () => {
    let signal: AbortSignal | undefined
    const { definition, cms } = shop({
      slow: {
        timeoutSeconds: 1,
        handler: (_args: never, run: JobRun) => {
          signal = run.signal
          return new Promise<void>(() => {})
        },
      },
    })
    const kernel = await bootKernel({ plugins: [definition] })
    await cms().jobs.enqueue('shop.slow', {})

    expect((await kernel.jobs.runDue()).ran).toBe(1)
    expect(signal?.aborted).toBe(true)
    const { jobs } = await kernel.jobs.list()
    expect(jobs[0]).toMatchObject({
      status: 'failed',
      lastError: 'It ran longer than its 1 seconds',
    })
  })

  it('takes over a job whose server stopped, once its lock has run out', async () => {
    const { definition, ran, cms } = shop({ flaky: { attempts: 2 }, 'send-receipt': {} })
    const kernel = await bootKernel({ plugins: [definition] })
    await cms().jobs.enqueue('shop.flaky', { order: 'retried' })
    await cms().jobs.enqueue('shop.send-receipt', { order: 'no try left' })
    // As a server leaves them when it stops mid-run.
    await kernel.db.execute(sql`
      UPDATE cms_jobs SET status = 'running', attempts = 1, locked_until = now() + interval '5 minutes'
    `)

    // Still locked: the server may be alive. The lock is when to look again.
    const waiting = await kernel.jobs.runDue()
    expect(waiting.ran).toBe(0)
    expect(waiting.nextDue!.getTime() - Date.now()).toBeGreaterThan(290_000)

    await kernel.db.execute(sql`UPDATE cms_jobs SET locked_until = now() - interval '1 second'`)
    expect((await kernel.jobs.runDue()).ran).toBe(2)
    expect(ran.map((job) => job.args)).toEqual([{ order: 'retried' }])
    const { jobs } = await kernel.jobs.list({ perPage: 10 })
    expect(Object.fromEntries(jobs.map((job) => [job.name, [job.status, job.lastError]]))).toEqual({
      'shop.flaky': ['done', null],
      'shop.send-receipt': ['failed', 'The server stopped while this job ran'],
    })
  })
})

describe('repeating jobs', () => {
  const HOUR = 3600

  it('runs every interval, keeping to its rhythm', async () => {
    const { definition, ran } = shop({ 'sync-stock': { everySeconds: HOUR } })
    const kernel = await bootKernel({ plugins: [definition] })

    // The first run is one interval after the site first sees the job.
    const first = await kernel.jobs.runDue()
    expect(first.ran).toBe(0)
    expect(first.nextDue!.getTime() - Date.now()).toBeGreaterThan((HOUR - 5) * 1000)
    expect(first.nextDue!.getTime() - Date.now()).toBeLessThanOrEqual(HOUR * 1000)

    // Two and a half intervals on, it runs once, and next on the hour it would have.
    await pass(kernel, HOUR * 3.5)
    const second = await kernel.jobs.runDue()
    expect(second.ran).toBe(1)
    expect(ran).toHaveLength(1)
    const untilNext = second.nextDue!.getTime() - Date.now()
    expect(untilNext).toBeGreaterThan((HOUR / 2 - 5) * 1000)
    expect(untilNext).toBeLessThanOrEqual((HOUR / 2) * 1000)
    expect(await rows(kernel)).toEqual(
      expect.arrayContaining([
        { name: 'shop.sync-stock', status: 'done', attempts: 1 },
        { name: 'shop.sync-stock', status: 'pending', attempts: 0 },
      ]),
    )
  })

  it('goes on after a failed run', async () => {
    const { definition, state } = shop({ 'sync-stock': { everySeconds: HOUR } })
    const kernel = await bootKernel({ plugins: [definition] })
    await kernel.jobs.runDue()
    await pass(kernel, HOUR + 1)
    state.fail = 1
    expect((await kernel.jobs.runDue()).ran).toBe(1)
    expect(await kernel.jobs.counts()).toMatchObject({ failed: 1, pending: 1 })
  })

  it('follows the definition: a new interval, no longer repeating, or its plugin gone', async () => {
    const db = createDb()
    const boot = async (plugins: KernelOptions['plugins']) => {
      const kernel = await createKernel({
        db,
        plugins,
        logger: memoryLogger(),
        strict: true,
        passwordHashing: 'fast',
      })
      const { nextDue } = await kernel.jobs.runDue()
      const { jobs } = await kernel.jobs.list({ status: 'pending' })
      return {
        kernel,
        inSeconds: nextDue ? Math.round((nextDue.getTime() - Date.now()) / 1000) : null,
        waiting: jobs.map((job) => [job.name, job.everySeconds, job.defined]),
      }
    }

    const hourly = await boot([shop({ 'sync-stock': { everySeconds: HOUR } }).definition])
    expect(hourly.waiting).toEqual([['shop.sync-stock', HOUR, true]])

    // Booting again changes nothing.
    const again = await boot([shop({ 'sync-stock': { everySeconds: HOUR } }).definition])
    expect(again.waiting).toEqual(hourly.waiting)
    expect(await again.kernel.jobs.counts()).toMatchObject({ pending: 1 })

    const daily = await boot([shop({ 'sync-stock': { everySeconds: 24 * HOUR } }).definition])
    expect(daily.waiting).toEqual([['shop.sync-stock', 24 * HOUR, true]])
    expect(daily.inSeconds).toBeGreaterThan(23 * HOUR)

    // Its plugin is off: the run waits, and nothing looks for it.
    const off = await boot([plugin('other')])
    expect(off.waiting).toEqual([['shop.sync-stock', 24 * HOUR, false]])
    expect(off.inSeconds).toBeNull()

    const once = await boot([shop({ 'sync-stock': {} }).definition])
    expect(once.waiting).toEqual([])
  })
})

describe('the cron request', () => {
  const cron = (kernel: Kernel, authorization?: string) =>
    kernel.handleApi(
      new Request('http://cms.test/api/p/core/cron', {
        headers: authorization ? { authorization } : {},
      }),
    )

  it('runs what is due for a caller with the site’s secret', async () => {
    const { definition, ran, cms } = shop()
    const kernel = await bootKernel({ plugins: [definition], env: { CRON_SECRET: 's3cret-value' } })
    await cms().jobs.enqueue('shop.send-receipt', { order: 'A-1' })
    const at = new Date(Date.now() + 3600_000)
    await cms().jobs.enqueue('shop.send-receipt', { order: 'A-2' }, { at })

    for (const wrong of [undefined, 's3cret-value', 'Bearer nope', 'Bearer s3cret-valu']) {
      const refused = await cron(kernel, wrong)
      expect(refused.status).toBe(401)
    }
    expect(ran).toEqual([])

    const response = await cron(kernel, 'Bearer s3cret-value')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ran: 1, nextDue: at.toISOString() })
    expect(ran).toHaveLength(1)
  })

  it('isn’t there on a site without a secret', async () => {
    const { definition, ran, cms } = shop()
    const kernel = await bootKernel({ plugins: [definition] })
    await cms().jobs.enqueue('shop.send-receipt', { order: 'A-1' })
    expect((await cron(kernel, 'Bearer ')).status).toBe(404)
    expect((await cron(kernel, 'Bearer undefined')).status).toBe(404)
    expect(ran).toEqual([])
  })
})

describe('the admin’s view', () => {
  it('lists jobs by status and name, counts them, and runs or cancels one', async () => {
    const { definition, ran, state, cms } = shop({
      'send-receipt': { label: 'Send a receipt' },
      reindex: {},
    })
    const woken: Date[] = []
    const kernel = await bootKernel({
      plugins: [definition],
      onJobQueued: (dueAt) => woken.push(dueAt),
    })
    const inMinutes = (minutes: number) => ({ at: new Date(Date.now() + minutes * 60_000) })
    const failing = await cms().jobs.enqueue('shop.send-receipt', { order: 'A-1' })
    state.fail = 1
    await kernel.jobs.runDue()
    const waiting = await cms().jobs.enqueue('shop.send-receipt', { order: 'A-2' }, inMinutes(30))
    const unwanted = await cms().jobs.enqueue('shop.reindex', {}, inMinutes(60))

    expect(await kernel.jobs.counts()).toEqual({
      pending: 2,
      running: 0,
      done: 0,
      failed: 1,
      cancelled: 0,
    })
    const pending = await kernel.jobs.list({ status: 'pending' })
    expect(pending.total).toBe(2)
    // Waiting jobs come soonest first.
    expect(pending.jobs.map((job) => job.label)).toEqual(['Send a receipt', 'shop.reindex'])
    expect((await kernel.jobs.list({ search: 'REINDEX' })).jobs.map((job) => job.id)).toEqual([
      unwanted,
    ])
    expect((await kernel.jobs.list({ perPage: 1, page: 2 })).jobs).toHaveLength(1)

    expect(await kernel.jobs.cancelOne(unwanted!)).toBe(true)
    expect(await kernel.jobs.cancelOne(unwanted!)).toBe(false)

    // A waiting job runs now; a failed one starts over.
    woken.length = 0
    expect(await kernel.jobs.runNow(waiting!)).toBe(true)
    expect(await kernel.jobs.runNow(failing!)).toBe(true)
    expect(await kernel.jobs.runNow(unwanted!)).toBe(false)
    expect(woken).toHaveLength(2)
    expect((await kernel.jobs.runDue()).ran).toBe(2)
    expect(ran).toHaveLength(3)
    expect(await kernel.jobs.counts()).toMatchObject({ done: 2, failed: 0, cancelled: 1 })
  })

  it('deletes what finished long ago', async () => {
    const { definition, cms } = shop()
    const kernel = await bootKernel({ plugins: [definition] })
    await cms().jobs.enqueue('shop.send-receipt', { order: 'old' })
    await cms().jobs.enqueue('shop.send-receipt', { order: 'new' })
    await kernel.jobs.runDue({ limit: 1 })
    await kernel.db.execute(
      sql`UPDATE cms_jobs SET finished_at = now() - interval '31 days' WHERE status = 'done'`,
    )
    await kernel.jobs.runDue()

    expect(await kernel.jobs.prune(30)).toBe(1)
    expect(await kernel.jobs.counts()).toMatchObject({ done: 1 })
  })
})
