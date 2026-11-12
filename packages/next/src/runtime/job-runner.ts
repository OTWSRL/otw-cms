/** What a look at the queue did, and when the next job is due. */
export interface JobsRun {
  ran: number
  nextDue: Date | null
}

export interface JobRunnerOptions {
  /** Runs the jobs that are due, with the site's current kernel. */
  runDue(): Promise<JobsRun>
  /**
   * How often to look when nothing is known to be due, for jobs another server queued. 0 for the
   * embedded database, which only this process writes: there, nothing looks while nothing waits.
   */
  recheckMs: number
  log(message: string, error: unknown): void
  now?: () => number
}

export interface JobRunner {
  /** A job is due at this time: look then, unless a look is planned sooner. */
  wake(dueAt: Date): void
  /** Looks now, and resolves once what was due has run. */
  look(): Promise<void>
  /** Drops the timer, for tests and reloads. */
  stop(): void
}

/** `setTimeout` takes at most 24.8 days; a day at a time keeps well under it. */
const MAX_SLEEP_MS = 24 * 60 * 60 * 1000
/** When to try again after the queue couldn't be read. */
const RETRY_MS = 60_000

/**
 * Runs the site's jobs from inside its process: one timer, set to the time the next job is due,
 * and nothing while none waits. It never polls; a job queued by this process wakes it.
 */
export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const now = options.now ?? Date.now
  let timer: NodeJS.Timeout | undefined
  let timerAt = Number.POSITIVE_INFINITY
  let looking: Promise<void> | undefined
  let again = false
  let stopped = false

  const plan = (at: number) => {
    if (stopped || (timer && timerAt <= at)) return
    clearTimeout(timer)
    timerAt = at
    const sleep = Math.min(Math.max(at - now(), 0), MAX_SLEEP_MS)
    // Never the reason the process stays up.
    timer = setTimeout(() => {
      timer = undefined
      timerAt = Number.POSITIVE_INFINITY
      void look()
    }, sleep).unref()
  }

  const look = (): Promise<void> => {
    if (looking) {
      // Something became due while jobs ran: look once more before sleeping.
      again = true
      return looking
    }
    looking = (async () => {
      try {
        let nextDue: Date | null
        do {
          again = false
          ;({ nextDue } = await options.runDue())
        } while (again)
        if (nextDue) plan(nextDue.getTime())
        if (options.recheckMs > 0) plan(now() + options.recheckMs)
      } catch (error) {
        options.log('cms: running the due jobs failed, and is tried again in a minute', error)
        plan(now() + RETRY_MS)
      } finally {
        looking = undefined
      }
    })()
    return looking
  }

  return {
    wake: (dueAt) => plan(dueAt.getTime()),
    look,
    stop() {
      stopped = true
      clearTimeout(timer)
      timer = undefined
    },
  }
}
