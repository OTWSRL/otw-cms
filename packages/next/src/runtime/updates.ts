import type { Env, UpdateOverview, UpdateService } from '@otwdesign/core'
import { ActionError } from '@otwdesign/sdk'

type Fetch = typeof fetch

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** How long the admin reuses the supervisor's status: the menu's update count asks on every screen. */
export const STATUS_CACHE_MS = 5_000
/** The status is for a badge: a supervisor that's slow to answer mustn't hold up every screen. */
const STATUS_TIMEOUT_MS = 3_000

interface CachedStatus {
  at: number
  overview: Promise<UpdateOverview>
}

/**
 * The last status per supervisor, on globalThis: Next bundles route handlers and server components
 * apart, each with its own kernel, and an update started from a form (a route handler) must clear
 * the status the admin's screens (server components) show next.
 */
const globalForUpdates = globalThis as typeof globalThis & {
  __cmsUpdateStatus?: Map<string, CachedStatus>
}

/**
 * The `cms serve` supervisor that started this release. It passed its address and a token in
 * the environment; nothing else can call it.
 */
export function supervisorUpdates(
  url: string,
  token: string,
  fetchImpl: Fetch = fetch,
  {
    now = Date.now,
    statuses = (globalForUpdates.__cmsUpdateStatus ??= new Map()),
  }: { now?: () => number; statuses?: Map<string, CachedStatus> } = {},
): UpdateService {
  const call = async (method: string, path: string, body?: unknown, timeoutMs = 10_000) => {
    let response: Response
    try {
      response = await fetchImpl(`${url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new ActionError(`Couldn't reach cms serve: ${describe(error)}`)
    }
    const data = (await response.json().catch(() => ({}))) as { error?: string; notice?: string }
    if (!response.ok) throw new ActionError(data.error ?? `cms serve answered ${response.status}.`)
    return data
  }
  /**
   * The last status, reused for a few seconds and shared by requests asking at once. Not while an
   * update runs, whose steps the Updates screen shows as they happen, and forgotten after anything
   * that changes it.
   */
  const forget = () => {
    statuses.delete(url)
  }
  const notice = async (method: string, path: string, body?: unknown, timeoutMs?: number) => {
    try {
      return (await call(method, path, body, timeoutMs)).notice ?? 'Done.'
    } finally {
      forget()
    }
  }
  return {
    overview() {
      const at = now()
      const cached = statuses.get(url)
      if (cached && at - cached.at < STATUS_CACHE_MS) return cached.overview
      const overview = call('GET', '/status', undefined, STATUS_TIMEOUT_MS).then(
        (status) => status as UpdateOverview,
        (error: unknown): UpdateOverview => ({ channel: 'unavailable', reason: describe(error) }),
      )
      const entry = { at, overview }
      statuses.set(url, entry)
      void overview.then((status) => {
        const running = status.channel === 'serve' && status.job?.status === 'running'
        if (running && statuses.get(url) === entry) {
          forget()
        }
      })
      return overview
    },
    // Looking up every package can take a while on a slow registry.
    check: () => notice('POST', '/check', undefined, 120_000),
    update: (request) => notice('POST', '/update', request),
    rollback: (release) => notice('POST', '/rollback', { release }),
    setAutoUpdate: (mode) => notice('PUT', '/auto-update', { mode }),
    install: (packageName) => notice('POST', '/install', { package: packageName }),
    remove: (packageName) => notice('POST', '/remove', { package: packageName }),
  }
}

export interface GitHubUpdatesOptions {
  /** `owner/name`. */
  repository: string
  /** Allowed to run workflows (`actions: write`) in that repository. */
  token: string
  workflow?: string
  /** The branch the workflow runs on and the pull request goes into. */
  ref?: string
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const WORKFLOW = /^[A-Za-z0-9_.-]+\.ya?ml$/

/**
 * For sites that build from git: the update runs in the repository's `cms-update.yml` workflow,
 * which commits it on a branch and opens a pull request. Merging deploys it.
 */
export function githubUpdates(
  { repository, token, workflow = 'cms-update.yml', ref = 'main' }: GitHubUpdatesOptions,
  fetchImpl: Fetch = fetch,
): UpdateService {
  if (!REPOSITORY.test(repository)) throw new Error('CMS_GITHUB_REPO must look like owner/name')
  if (!WORKFLOW.test(workflow)) throw new Error('CMS_GITHUB_WORKFLOW must be a workflow file name')
  const runsUrl = `https://github.com/${repository}/actions/workflows/${workflow}`
  const dispatch = async (
    inputs: Record<string, string>,
    started = 'Started the update on GitHub. It opens a pull request if there is anything to update',
  ) => {
    let response: Response
    try {
      response = await fetchImpl(
        `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ref, inputs }),
          signal: AbortSignal.timeout(15_000),
        },
      )
    } catch (error) {
      throw new ActionError(`Couldn't reach GitHub: ${describe(error)}`)
    }
    if (response.status !== 204) {
      const { message } = (await response.json().catch(() => ({}))) as { message?: string }
      throw new ActionError(
        `GitHub didn't start the update workflow (${response.status}${message ? `: ${message}` : ''}). Check that ${workflow} exists on ${ref} and the token may run workflows.`,
      )
    }
    return `${started}: ${runsUrl}`
  }
  // GitHub refuses an input the workflow file doesn't declare, and a site made before plugins
  // could be added from the admin has the older file: updates send only what it has always had.
  const updating = { packages: '', plugins_only: 'false' }
  const plugin = async (input: 'add_plugin' | 'remove_plugin', name: string, started: string) => {
    try {
      return await dispatch({ ...updating, [input]: name }, started)
    } catch (error) {
      if (error instanceof ActionError && /\(422/.test(error.message)) {
        throw new ActionError(
          `The site's ${workflow} is from before plugins could be added from the admin. Replace it with the one a new site has (it takes add_plugin and remove_plugin), or run \`cms plugin\` yourself.`,
        )
      }
      throw error
    }
  }
  return {
    overview: async () => ({ channel: 'github', repository, runsUrl }),
    check: () => dispatch(updating),
    update: (request) =>
      dispatch({
        ...updating,
        packages: (request.packages ?? []).join(' '),
        plugins_only: String(request.pluginsOnly === true),
      }),
    install: (packageName) =>
      plugin(
        'add_plugin',
        packageName,
        `Asked GitHub to add ${packageName}. It opens a pull request; merging it deploys the plugin, inactive`,
      ),
    remove: (packageName) =>
      plugin(
        'remove_plugin',
        packageName,
        `Asked GitHub to remove ${packageName}. It opens a pull request; merging it deploys the site without it`,
      ),
    rollback: async () => {
      throw new ActionError('To go back, revert the update’s pull request on GitHub.')
    },
    setAutoUpdate: async () => {
      throw new ActionError(
        `The workflow's schedule decides when updates are proposed: edit it in .github/workflows/${workflow}.`,
      )
    },
  }
}

/**
 * How this site applies updates: `cms serve`'s supervisor when it started this release, a GitHub
 * workflow when the repository is configured, otherwise none (the admin shows the commands).
 */
export function updateServiceFromEnv(env: Env): UpdateService | undefined {
  if (env.CMS_SUPERVISOR_URL && env.CMS_SUPERVISOR_TOKEN) {
    return supervisorUpdates(env.CMS_SUPERVISOR_URL, env.CMS_SUPERVISOR_TOKEN)
  }
  if (env.CMS_GITHUB_REPO && env.CMS_GITHUB_TOKEN) {
    return githubUpdates({
      repository: env.CMS_GITHUB_REPO,
      token: env.CMS_GITHUB_TOKEN,
      workflow: env.CMS_GITHUB_WORKFLOW || undefined,
      ref: env.CMS_GITHUB_REF || undefined,
    })
  }
  return undefined
}
