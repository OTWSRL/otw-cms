import 'server-only'
import { createKernelHolder, type Kernel, type KernelHolder } from '@otwdesign/core'
import { after } from 'next/server'
import { currentSite, type Site } from '../site-registry'
import { bootSite } from './boot'
import { openDatabase, type DatabaseHandle } from './database'
import { createJobRunner, type JobRunner } from './job-runner'

// The connection lives on globalThis: PGlite allows one instance per data directory, and dev
// reloads must not open a second one. The change counter is shared the same way, so a change
// made by a route handler reaches the server-component bundle at once. Kernels stay per bundle
// (see site-registry.ts).
const globalForCms = globalThis as typeof globalThis & {
  __cmsDatabase?: DatabaseHandle
  __cmsChanges?: number
  __cmsJobs?: { runner: JobRunner; kernel: () => Promise<Kernel> }
}

/** After a server starts, how long until it first looks for jobs that came due while it was down. */
const FIRST_LOOK_MS = 10_000
/** With PostgreSQL, how often a server looks for jobs another server queued. */
const RECHECK_MS = 60_000

/**
 * What runs the site's jobs in this process, one for both bundles: it uses the kernel of whichever
 * booted last, since both define the same jobs.
 */
function jobRunner(kernel: () => Promise<Kernel>): JobRunner {
  const jobs = globalForCms.__cmsJobs
  if (jobs) {
    jobs.kernel = kernel
    return jobs.runner
  }
  const runner = createJobRunner({
    runDue: async () => (await globalForCms.__cmsJobs!.kernel()).jobs.runDue(),
    // The embedded database is this process's alone; a PostgreSQL server may have other writers.
    recheckMs: process.env.DATABASE_URL ? RECHECK_MS : 0,
    log: (message, error) =>
      console.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`),
  })
  globalForCms.__cmsJobs = { runner, kernel }
  runner.wake(new Date(Date.now() + FIRST_LOOK_MS))
  return runner
}

/**
 * A job was queued. One due now runs once this request's response has been sent, so it never
 * competes with the request that queued it, and on serverless hosts, where nothing runs between
 * requests, it still runs. One for later, or queued outside a request, wakes the timer.
 */
function wakeJobs(runner: JobRunner, dueAt: Date): void {
  if (dueAt.getTime() <= Date.now()) {
    try {
      after(() => runner.look())
      return
    } catch {
      // Not in a request: the timer takes it.
    }
  }
  runner.wake(dueAt)
}

// Keyed by site, so a dev reload that regenerates the site module boots the new plugin list.
const holders = new WeakMap<Site, KernelHolder>()

function holderFor(site: Site): KernelHolder {
  let holder = holders.get(site)
  if (!holder) {
    const created = createKernelHolder({
      boot: () =>
        bootSite(
          site,
          (globalForCms.__cmsDatabase ??= openDatabase(process.env, { maintain: true })).db,
          {
            onChange: () => {
              globalForCms.__cmsChanges = (globalForCms.__cmsChanges ?? 0) + 1
            },
            onJobQueued: (dueAt) => wakeJobs(runner, dueAt),
          },
        ),
      localChanges: () => globalForCms.__cmsChanges ?? 0,
    })
    const runner = jobRunner(() => created.get())
    holder = created
    holders.set(site, holder)
  }
  return holder
}

/**
 * The site's kernel, for server components, route handlers and server actions: settings,
 * capability checks, slots, plugin services. Booted once, and replaced after an admin changes
 * plugins or settings.
 */
export function getKernel(): Promise<Kernel> {
  return holderFor(currentSite()).get()
}
