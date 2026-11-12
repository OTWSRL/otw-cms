import type {
  AutoUpdateMode,
  PackageChange,
  ReleaseRecord,
  UpdateCheck,
  UpdateJob,
  UpdateOverview,
  UpdateRequest,
} from '@otwdesign/core'
import type { UpdatePlan, UpdateScope } from '../update.ts'
import { ControlError } from './control.ts'

export interface Release extends ReleaseRecord {
  /** Where it is built, under `.cms/releases`. */
  dir: string
}

/** A release as built, before the supervisor knows whether it will go live. */
export type BuiltRelease = Omit<Release, 'status' | 'reason'>

/** What `cms serve` remembers between restarts, in `.cms/state.json`. */
export interface ServeState {
  current: string | null
  releases: Release[]
  autoUpdate: AutoUpdateMode
  lastCheck: UpdateCheck | null
}

/** A running release: its port behind the proxy, and how to stop it. */
export interface RunningRelease {
  port: number
  stop(): Promise<void>
}

export type Log = (line: string) => void

/** Everything with a side effect, so the steps can be tested without building real sites. */
export interface SupervisorDeps {
  /** What an update would change, judged from what a release has installed. */
  plan(release: Release, scope: UpdateScope): Promise<UpdatePlan>
  /** What adding a plugin's package to a release would change. */
  planInstall(release: Release, packageName: string): Promise<UpdatePlan>
  /** What taking a plugin's package off a release would change. */
  planRemove(release: Release, packageName: string): Promise<UpdatePlan>
  /** Copies the site into a new release, applies `changes`, installs and builds it. */
  build(id: string, changes: readonly PackageChange[], log: Log): Promise<BuiltRelease>
  /** Runs the release's own `cms migrate`, so its migrations are the ones that run. */
  migrate(release: BuiltRelease, log: Log): Promise<void>
  /** Copies the embedded database aside; `null` with Postgres, where `cms migrate` dumps it. */
  backup(): Promise<string | null>
  restore(backup: string): Promise<void>
  /** Resolves once the release answers; rejects (and stops it) if it doesn't. */
  start(release: BuiltRelease, log: Log): Promise<RunningRelease>
  /** Copies the update back to the site: package.json, lockfile, managed route files. */
  writeBack(release: BuiltRelease, changes: readonly PackageChange[]): Promise<void>
  remove(release: BuiltRelease): Promise<void>
  save(state: ServeState): Promise<void>
  now(): Date
}

export interface SupervisorOptions {
  /** The embedded database belongs to one process: releases can't overlap. */
  database: 'embedded' | 'postgres'
  /** Releases kept for rollback, the live one included. */
  keep?: number
}

const LOG_LINES = 200
/** Failed updates kept as records, for the Updates screen. */
const FAILED_KEPT = 5

class JobRun {
  readonly job: UpdateJob

  constructor(kind: UpdateJob['kind'], steps: readonly string[], now: Date) {
    this.job = {
      id: `${kind}-${now.getTime().toString(36)}`,
      kind,
      status: 'running',
      startedAt: now.toISOString(),
      steps: steps.map((name) => ({ name, status: 'pending' })),
      log: [],
    }
  }

  readonly log: Log = (line) => {
    this.job.log.push(...line.split('\n').filter(Boolean))
    if (this.job.log.length > LOG_LINES) this.job.log.splice(0, this.job.log.length - LOG_LINES)
  }

  async step<T>(name: string, work: () => Promise<T>): Promise<T> {
    const step = this.job.steps.find((each) => each.name === name)!
    step.status = 'running'
    this.log(`== ${name}`)
    try {
      const result = await work()
      step.status = 'done'
      return result
    } catch (error) {
      step.status = 'failed'
      this.log(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  finish(status: 'succeeded' | 'failed', summary: string, now: Date): void {
    for (const step of this.job.steps) if (step.status === 'pending') step.status = 'skipped'
    this.job.status = status
    this.job.summary = summary
    this.job.finishedAt = now.toISOString()
  }
}

const UPDATE_STEPS = [
  'Check versions',
  'Build the new release',
  'Back up and migrate',
  'Start the new release',
  'Switch',
  'Finish',
] as const

function describeChanges(changes: readonly PackageChange[]): string {
  return changes
    .map((change) =>
      change.from === ''
        ? `${change.name} ${change.to} added`
        : change.to === ''
          ? `${change.name} removed`
          : `${change.name} ${change.from} → ${change.to}`,
    )
    .join(', ')
}

/** What a job that builds and switches to a new release says, by what it's for. */
interface Wording {
  /** The plan changes nothing. */
  unchanged: string
  refused(blockers: readonly string[]): string
  done(changes: readonly PackageChange[]): string
}

const UPDATE_WORDING: Wording = {
  unchanged: 'Already up to date.',
  refused: (blockers) => `Not updated: ${blockers.join(' ')}`,
  done: (changes) => `Updated: ${describeChanges(changes)}.`,
}

function toCheck(plan: UpdatePlan, at: Date): UpdateCheck {
  return {
    at: at.toISOString(),
    core: plan.core,
    plugins: plan.plugins.map((plugin) => ({ ...plugin })),
    warnings: plan.warnings,
    blockers: plan.blockers,
  }
}

/**
 * Runs the site from built releases and swaps them: update, roll back, and the twice-daily check.
 * One job at a time. The live release's port is what the proxy forwards to; `null` while the
 * embedded database is between releases.
 */
export class Supervisor {
  readonly #state: ServeState
  readonly #deps: SupervisorDeps
  readonly #options: Required<SupervisorOptions>
  #live: RunningRelease | null = null
  #job: JobRun | null = null
  #running: Promise<void> | null = null

  constructor(state: ServeState, deps: SupervisorDeps, options: SupervisorOptions) {
    this.#state = state
    this.#deps = deps
    this.#options = { keep: 3, ...options }
  }

  /** The port the proxy forwards to. */
  target(): number | null {
    return this.#live?.port ?? null
  }

  /** Settles when the current job has finished, for tests and shutdown. */
  idle(): Promise<void> {
    return this.#running ?? Promise.resolve()
  }

  #current(): Release | undefined {
    return this.#state.releases.find((release) => release.id === this.#state.current)
  }

  /** Starts the live release, building the site into one first if there is none. */
  async start(log: Log): Promise<void> {
    let release: BuiltRelease | undefined = this.#current()
    if (!release) {
      log('Building the site into its first release…')
      const built = await this.#deps.build(this.#releaseId(), [], log)
      this.#state.releases.push({ ...built, status: 'live' })
      this.#state.current = built.id
      await this.#deps.save(this.#state)
      release = built
    }
    this.#live = await this.#deps.start(release, log)
  }

  async stop(): Promise<void> {
    await this.idle()
    await this.#live?.stop()
    this.#live = null
  }

  overview(): Extract<UpdateOverview, { channel: 'serve' }> {
    const strip = ({ dir: _dir, ...record }: Release): ReleaseRecord => record
    const current = this.#current()
    return {
      channel: 'serve',
      database: this.#options.database,
      current: current ? strip(current) : null,
      releases: this.#state.releases.map(strip),
      autoUpdate: this.#state.autoUpdate,
      lastCheck: this.#state.lastCheck,
      job: this.#job?.job ?? null,
    }
  }

  #releaseId(): string {
    return this.#deps
      .now()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..*$/, '')
      .replace('T', '-')
  }

  #begin(kind: UpdateJob['kind'], steps: readonly string[]): JobRun {
    if (this.#job?.job.status === 'running') {
      throw new ControlError(409, 'An update is already running. Wait for it to finish.')
    }
    const run = new JobRun(kind, steps, this.#deps.now())
    this.#job = run
    return run
  }

  /** Checks now, and keeps the result for the Updates screen. */
  async check(): Promise<string> {
    const current = this.#current()
    if (!current) throw new ControlError(409, 'The site has no release yet.')
    const run = this.#begin('check', ['Check versions'])
    try {
      const plan = await run.step('Check versions', () => this.#deps.plan(current, {}))
      this.#state.lastCheck = toCheck(plan, this.#deps.now())
      await this.#deps.save(this.#state)
      const count = (plan.core ? 1 : 0) + plan.plugins.filter((plugin) => plugin.to).length
      const summary = count === 0 ? 'Everything is up to date.' : `${count} update(s) available.`
      run.finish('succeeded', summary, this.#deps.now())
      return summary
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#state.lastCheck = { ...toCheck(EMPTY_PLAN, this.#deps.now()), error: message }
      await this.#deps.save(this.#state)
      run.finish('failed', `Couldn't check for updates: ${message}`, this.#deps.now())
      return `Couldn't check for updates: ${message}`
    }
  }

  /** Starts an update in the background; the Updates screen follows its steps. */
  update(request: UpdateRequest & { patchOnly?: boolean }): string {
    const current = this.#current()
    if (!current) throw new ControlError(409, 'The site has no release yet.')
    const run = this.#begin('update', UPDATE_STEPS)
    const scope: UpdateScope = {
      only: request.packages?.length ? request.packages : undefined,
      pluginsOnly: request.pluginsOnly,
      patchOnly: request.patchOnly,
    }
    this.#running = this.#apply(run, current, () => this.#deps.plan(current, scope)).finally(() => {
      this.#running = null
    })
    return 'Updating. This page shows the progress.'
  }

  /** Adds a plugin's package in a new release, like WordPress's Install Now. It arrives inactive. */
  install(packageName: string): string {
    const current = this.#current()
    if (!current) throw new ControlError(409, 'The site has no release yet.')
    const run = this.#begin('install', UPDATE_STEPS)
    this.#running = this.#apply(run, current, () => this.#deps.planInstall(current, packageName), {
      unchanged: `${packageName} was not installed.`,
      refused: (blockers) => `Not installed: ${blockers.join(' ')}`,
      done: (changes) =>
        `Installed ${changes.map((change) => `${change.name} ${change.to}`).join(', ')}. Activate it on the Plugins screen.`,
    }).finally(() => {
      this.#running = null
    })
    return `Installing ${packageName}. Dashboard › Updates shows the progress.`
  }

  /** Takes a plugin's package off the site in a new release, like WordPress's Delete. */
  remove(packageName: string): string {
    const current = this.#current()
    if (!current) throw new ControlError(409, 'The site has no release yet.')
    const run = this.#begin('remove', UPDATE_STEPS)
    this.#running = this.#apply(run, current, () => this.#deps.planRemove(current, packageName), {
      unchanged: `${packageName} was not removed.`,
      refused: (blockers) => `Not removed: ${blockers.join(' ')}`,
      done: (changes) => `Removed ${changes.map((change) => change.name).join(', ')}.`,
    }).finally(() => {
      this.#running = null
    })
    return `Removing ${packageName}. Dashboard › Updates shows the progress.`
  }

  /** Builds the release a plan describes, and switches to it: an update, an install, a removal. */
  async #apply(
    run: JobRun,
    current: Release,
    planner: () => Promise<UpdatePlan>,
    wording: Wording = UPDATE_WORDING,
  ): Promise<void> {
    const { now } = this.#deps
    let plan: UpdatePlan
    try {
      plan = await run.step('Check versions', planner)
    } catch (error) {
      return run.finish('failed', `Couldn't check versions: ${message(error)}`, now())
    }
    // Why not comes before "nothing to do": a refused install changes nothing either.
    if (plan.blockers.length > 0) return run.finish('failed', wording.refused(plan.blockers), now())
    if (plan.changes.length === 0) return run.finish('succeeded', wording.unchanged, now())

    let release: BuiltRelease
    try {
      release = await run.step('Build the new release', () =>
        this.#deps.build(this.#releaseId(), plan.changes, run.log),
      )
    } catch (error) {
      return run.finish(
        'failed',
        `The new release didn't build, so nothing changed: ${message(error)}`,
        now(),
      )
    }

    const embedded = this.#options.database === 'embedded'
    const previous = this.#live
    let backup: string | null = null
    try {
      await run.step('Back up and migrate', async () => {
        if (embedded) {
          // Only one process may hold the embedded database: visitors get "being updated".
          this.#live = null
          await previous?.stop()
          backup = await this.#deps.backup()
        }
        await this.#deps.migrate(release, run.log)
      })
      const next = await run.step('Start the new release', () => this.#deps.start(release, run.log))
      await run.step('Switch', async () => {
        this.#live = next
        if (!embedded) await previous?.stop().catch((error) => run.log(message(error)))
      })
    } catch (error) {
      const restored = await this.#recover(embedded, backup, current, run)
      this.#state.releases.push({ ...release, status: 'failed', reason: message(error) })
      await this.#deps.remove(release).catch(() => {})
      await this.#deps.save(this.#state)
      return run.finish(
        'failed',
        `${message(error)} ${restored ? 'The site is back on the release it was running.' : 'The previous release did not start again: see the log, and run `cms serve` again.'}`,
        now(),
      )
    }

    await run.step('Finish', async () => {
      await this.#deps.writeBack(release, plan.changes)
      for (const each of this.#state.releases) if (each.status === 'live') each.status = 'previous'
      this.#state.releases.push({ ...release, status: 'live' })
      this.#state.current = release.id
      // The check described the site before this update.
      this.#state.lastCheck = null
      await this.#prune()
      await this.#deps.save(this.#state)
    })
    run.finish('succeeded', wording.done(plan.changes), now())
  }

  /** After a failed update: the old release serves again, on its own database. */
  async #recover(embedded: boolean, backup: string | null, current: Release, run: JobRun) {
    if (!embedded) return this.#live !== null
    try {
      if (backup) await this.#deps.restore(backup)
      this.#live = await this.#deps.start(current, run.log)
      return true
    } catch (error) {
      run.log(`Restarting the previous release failed: ${message(error)}`)
      return false
    }
  }

  /** Keeps the newest releases that worked, never the live one; failed ones are only records. */
  async #prune(): Promise<void> {
    const working = this.#state.releases.filter((release) => release.status !== 'failed')
    const failed = this.#state.releases.filter((release) => release.status === 'failed')
    const excess = [
      ...working
        .slice(0, Math.max(0, working.length - this.#options.keep))
        .filter((release) => release.id !== this.#state.current),
      ...failed.slice(0, Math.max(0, failed.length - FAILED_KEPT)),
    ]
    for (const release of excess) {
      if (release.status !== 'failed') await this.#deps.remove(release).catch(() => {})
    }
    this.#state.releases = this.#state.releases.filter((release) => !excess.includes(release))
  }

  /** Switches back to an earlier release. Its code runs on the newer schema (migrations add). */
  rollback(id: string): string {
    const current = this.#current()
    const target = this.#state.releases.find((release) => release.id === id)
    if (!current || !target || target.status !== 'previous') {
      throw new ControlError(404, 'There is no earlier release with that id to go back to.')
    }
    const run = this.#begin('rollback', ['Start the previous release', 'Switch', 'Finish'])
    this.#running = this.#rollback(run, current, target).finally(() => {
      this.#running = null
    })
    return `Going back to the release from ${target.createdAt.slice(0, 16).replace('T', ' ')}.`
  }

  async #rollback(run: JobRun, current: Release, target: Release): Promise<void> {
    const { now } = this.#deps
    const embedded = this.#options.database === 'embedded'
    const previous = this.#live
    try {
      if (embedded) {
        this.#live = null
        await previous?.stop()
      }
      const next = await run.step('Start the previous release', () =>
        this.#deps.start(target, run.log),
      )
      await run.step('Switch', async () => {
        this.#live = next
        if (!embedded) await previous?.stop().catch((error) => run.log(message(error)))
      })
    } catch (error) {
      const restored = await this.#recover(embedded, null, current, run)
      return run.finish(
        'failed',
        `${message(error)} ${restored ? 'The site stayed on its current release.' : 'Run `cms serve` again.'}`,
        now(),
      )
    }
    await run.step('Finish', async () => {
      // What the release going live has that the one leaving doesn't, and the other way round:
      // a plugin added since goes from the site's files, one removed since comes back.
      const changes = [
        ...Object.entries(target.versions)
          .filter(([name, version]) => current.versions[name] !== version)
          .map(([name, version]) => ({ name, from: current.versions[name] ?? '', to: version })),
        ...Object.entries(current.versions)
          .filter(([name]) => !(name in target.versions))
          .map(([name, version]) => ({ name, from: version, to: '' })),
      ]
      await this.#deps.writeBack(target, changes)
      current.status = 'previous'
      target.status = 'live'
      this.#state.current = target.id
      this.#state.lastCheck = null
      await this.#deps.save(this.#state)
    })
    run.finish('succeeded', 'Rolled back.', now())
  }

  async setAutoUpdate(mode: AutoUpdateMode): Promise<string> {
    this.#state.autoUpdate = mode
    await this.#deps.save(this.#state)
    return mode === 'patch'
      ? 'Patch releases of core and plugins will be installed automatically.'
      : 'Automatic updates are off.'
  }

  /** The twice-daily run: check, then apply patch releases if automatic updates are on. */
  async tick(): Promise<void> {
    if (this.#job?.job.status === 'running') return
    await this.check()
    if (this.#state.autoUpdate !== 'patch') return
    const current = this.#current()
    if (!current) return
    const patches = await this.#deps.plan(current, { patchOnly: true }).catch(() => null)
    if (!patches || patches.changes.length === 0 || patches.blockers.length > 0) return
    this.update({ patchOnly: true })
    await this.idle()
  }
}

const EMPTY_PLAN: UpdatePlan = {
  core: null,
  changes: [],
  plugins: [],
  blockers: [],
  warnings: [],
  linked: [],
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
