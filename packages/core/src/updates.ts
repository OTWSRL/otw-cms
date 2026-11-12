/*
 * What the admin's Updates screen shows and asks for. The kernel doesn't apply updates: a site
 * has to be rebuilt to change, so the app hands it an update service for its hosting, such as
 * the `cms serve` supervisor on your own server or a GitHub workflow on git-based hosts.
 */

export type AutoUpdateMode = 'off' | 'patch'

export interface PackageChange {
  name: string
  /** Empty when the package is being added to the site. */
  from: string
  /** Empty when it is being removed. */
  to: string
}

export interface PluginUpdate {
  name: string
  from: string
  /** `null` when it stays where it is. */
  to: string | null
  /** The newest version published, usable or not. */
  latest: string | null
  /** Whether the version it would run declares support for the core it would run on. */
  compatible: 'yes' | 'unknown' | 'no'
  /** Why it isn't going to `latest`. */
  note?: string
}

export interface UpdateCheck {
  /** ISO timestamp. */
  at: string
  core: { from: string; to: string } | null
  plugins: PluginUpdate[]
  warnings: string[]
  /** Why updating everything would leave the site worse off. */
  blockers: string[]
  /** Set when the check itself failed. */
  error?: string
}

export interface ReleaseRecord {
  id: string
  createdAt: string
  /** Core and plugin package versions it runs. */
  versions: Record<string, string>
  status: 'live' | 'previous' | 'failed'
  reason?: string
}

export interface UpdateJobStep {
  name: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
}

export interface UpdateJob {
  id: string
  kind: 'check' | 'update' | 'rollback' | 'install' | 'remove'
  status: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt?: string
  steps: UpdateJobStep[]
  /** The last lines of output, for when something goes wrong. */
  log: string[]
  /** What happened, for the admin's notice. */
  summary?: string
}

export interface UpdateRequest {
  /** Package names; none means everything. */
  packages?: string[]
  pluginsOnly?: boolean
}

export type UpdateOverview =
  | {
      channel: 'serve'
      database: 'embedded' | 'postgres'
      current: ReleaseRecord | null
      releases: ReleaseRecord[]
      autoUpdate: AutoUpdateMode
      lastCheck: UpdateCheck | null
      job: UpdateJob | null
    }
  | {
      channel: 'github'
      repository: string
      /** Where the workflow's runs and their pull requests are listed. */
      runsUrl: string
    }
  | { channel: 'none' }
  /** Set up, but not answering now (the supervisor restarting, say). */
  | { channel: 'unavailable'; reason: string }

/** How many updates the menu badge shows: core counts as one. */
export function availableUpdates(overview: UpdateOverview): number {
  if (overview.channel !== 'serve' || !overview.lastCheck) return 0
  const { core, plugins } = overview.lastCheck
  return (core ? 1 : 0) + plugins.filter((plugin) => plugin.to).length
}

/** Each method returns the notice to show the administrator. */
export interface UpdateService {
  overview(): Promise<UpdateOverview>
  check(): Promise<string>
  update(request: UpdateRequest): Promise<string>
  rollback(releaseId: string): Promise<string>
  setAutoUpdate(mode: AutoUpdateMode): Promise<string>
  /**
   * Adds a plugin's npm package to the site and rebuilds it, like WordPress's Install Now. The
   * plugin arrives inactive. Missing where the hosting can't.
   */
  install?(packageName: string): Promise<string>
  /** Takes a plugin's package off the site and rebuilds it, like WordPress's Delete. */
  remove?(packageName: string): Promise<string>
}
