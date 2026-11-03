import { execFile } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Brand } from '@otwdesign/core'
import semver from 'semver'

const run = promisify(execFile)

/** The CMS's own packages, released together under one version. `@otwdesign/next` sets it. */
export const CORE_PACKAGES = [
  '@otwdesign/next',
  '@otwdesign/cli',
  '@otwdesign/core',
  '@otwdesign/sdk',
  '@otwdesign/admin-ui',
  '@otwdesign/testing',
] as const
const CORE_VERSION_FROM = '@otwdesign/next'
/** Plugins declare the core they work with as a peer dependency on one of these. */
const COMPATIBILITY_PEERS = ['@otwdesign/sdk', '@otwdesign/next']

/** The parts of npm's package metadata this reads: each version's peer dependencies. */
export interface Packument {
  name: string
  versions: Record<string, { version: string; peerDependencies?: Record<string, string> }>
}

/** A package npm couldn't look up, with its reason (not found, no access, offline). */
export interface Unreachable {
  name: string
  error: string
}

export type FetchVersions = (name: string, installed: string) => Promise<Packument>

type Runner = (
  file: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string }>

type ViewEntry = Packument['versions'][string]

function npmError(error: unknown): string {
  const stdout = (error as { stdout?: string }).stdout ?? ''
  try {
    const summary = (JSON.parse(stdout) as { error?: { summary?: string } }).error?.summary
    if (summary) return summary
  } catch {
    // Not npm's JSON: fall back to the process error.
  }
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
}

/**
 * Asks npm from the site's directory, so `.npmrc` applies: the registry, scoped registries for
 * private and paid plugins, and their tokens. npm ships with Node, and pnpm and Bun read the same
 * file.
 */
export function npmView(root: string, runner: Runner = run): FetchVersions {
  return async (name, installed) => {
    // Every stable version, or from a prerelease on, to include its later prereleases. Not `*`:
    // npm resolves that to the latest version alone.
    const range = semver.prerelease(installed) ? `>=${installed}` : '>=0.0.0'
    let stdout: string
    try {
      ;({ stdout } = await runner(
        'npm',
        ['view', `${name}@${range}`, 'version', 'peerDependencies', '--json'],
        { cwd: root },
      ))
    } catch (error) {
      throw new Error(npmError(error), { cause: error })
    }
    if (!stdout.trim()) return { name, versions: {} }
    // One matching version comes back alone, several as a list; a version without peer
    // dependencies comes back as just its version string.
    const parsed = JSON.parse(stdout) as ViewEntry | string | (ViewEntry | string)[]
    const entries = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) =>
      typeof entry === 'string' ? { version: entry } : entry,
    )
    return { name, versions: Object.fromEntries(entries.map((entry) => [entry.version, entry])) }
  }
}

export interface SitePackages {
  /** Name to the spec in package.json, such as `^0.1.0`. */
  specs: Record<string, string>
  /** Name to the version installed in node_modules. */
  installed: Record<string, string>
  /** Name to the installed version's peer dependencies, read from node_modules. */
  peers: Record<string, Record<string, string>>
  /** Plugin package names, from cms.config.json. */
  plugins: readonly string[]
}

export interface PluginReport {
  name: string
  from: string
  /** `null` when it stays on the installed version. */
  to: string | null
  /** The newest version published, whether or not it can be used. */
  latest: string | null
  /** Whether the version it ends on declares support for the target core. */
  compatible: 'yes' | 'unknown' | 'no'
  /** Why it isn't going to `latest`, when it isn't. */
  note?: string
}

export interface UpdatePlan {
  core: { from: string; to: string } | null
  /** Every package.json change, core and plugins. */
  changes: { name: string; from: string; to: string }[]
  /** The plugins this update looked at. */
  plugins: PluginReport[]
  /** Reasons the update would leave the site worse off; `--force` ignores them. */
  blockers: string[]
  /** Worth knowing, but no reason to stop. */
  warnings: string[]
  /** Packages that can't be updated from a registry, such as `workspace:` links. */
  linked: string[]
}

export interface UpdateScope {
  /** Allow a new major version of core. */
  major?: boolean
  /** Only these packages (from `resolveTargets`). Core packages move together. */
  only?: readonly string[]
  /** Leave core where it is. */
  pluginsOnly?: boolean
  /** Patch releases only (`~` of what's installed), for automatic updates. */
  patchOnly?: boolean
}

const INCLUDE_PRERELEASE = { includePrerelease: true }

/** Installed from a workspace, a folder or git: the registry has nothing to offer for it. */
export function isLinked(spec: string): boolean {
  return /^(workspace|file|link|git\+|github):/.test(spec) || spec.includes('/')
}

export function isCore(name: string): boolean {
  return (CORE_PACKAGES as readonly string[]).includes(name)
}

/** Stable releases, or prereleases too when the installed version is one. */
function candidates(packument: Packument, installed: string): string[] {
  const allowPrerelease = semver.prerelease(installed) !== null
  return Object.keys(packument.versions).filter(
    (version) => semver.valid(version) && (allowPrerelease || !semver.prerelease(version)),
  )
}

function coreSupport(
  peers: Readonly<Record<string, string>>,
  core: string,
): PluginReport['compatible'] {
  const range = COMPATIBILITY_PEERS.map((name) => peers[name]).find(Boolean)
  if (!range) return 'unknown'
  return semver.satisfies(core, range, INCLUDE_PRERELEASE) ? 'yes' : 'no'
}

/** `commerce` for `@otwdesign/plugin-commerce`, `forum` for `@acme/forum`, `core` for the CMS's own packages. */
export function resolveTargets(site: SitePackages, names: readonly string[]): string[] {
  return names.map((name) => {
    if (name === 'core') return CORE_VERSION_FROM
    if (site.plugins.includes(name) || (isCore(name) && name in site.specs)) return name
    const firstParty = `@otwdesign/plugin-${name}`
    if (site.plugins.includes(firstParty)) return firstParty
    // `forum` for `@acme/forum`, when only one installed plugin is called that.
    const unscoped = site.plugins.filter((plugin) => plugin.split('/').at(-1) === name)
    if (unscoped.length === 1) return unscoped[0]!
    if (unscoped.length > 1) {
      throw new Error(`${name} could be ${unscoped.join(' or ')}; use the full package name.`)
    }
    throw new Error(
      `${name} is not an installed plugin or a CMS package. Installed plugins: ${site.plugins.join(', ') || 'none'}.`,
    )
  })
}

function planCore(
  site: SitePackages,
  packuments: Readonly<Record<string, Packument | Unreachable>>,
  { major = false, patchOnly = false }: UpdateScope,
): { core: UpdatePlan['core']; changes: UpdatePlan['changes']; blockers: string[] } {
  const from = site.installed[CORE_VERSION_FROM]!
  const doc = packuments[CORE_VERSION_FROM]
  if (!doc || 'error' in doc) {
    throw new Error(`Can't look up ${CORE_VERSION_FROM}: ${doc?.error ?? 'not fetched'}`)
  }
  const range = patchOnly ? `~${from}` : major ? '*' : `^${from}`
  const target = semver.maxSatisfying(candidates(doc, from), range)
  if (!target || !semver.gt(target, from)) return { core: null, changes: [], blockers: [] }
  const changes: UpdatePlan['changes'] = []
  const blockers: string[] = []
  for (const name of CORE_PACKAGES.filter((n) => n in site.specs && !isLinked(site.specs[n]!))) {
    const published = packuments[name]
    if (!published || 'error' in published || !published.versions[target]) {
      blockers.push(`${name} ${target} is not published, and core packages update together.`)
    } else {
      changes.push({ name, from: site.installed[name] ?? site.specs[name]!, to: target })
    }
  }
  return { core: { from, to: target }, changes, blockers }
}

/**
 * Picks core (the newest within the installed version's caret range, or any with `major`) and
 * the newest version of each plugin that supports it. Plugins that say nothing about core stay
 * within their own caret range, flagged unknown, as WordPress shows "Compatibility: Unknown".
 *
 * Then it settles what plugins need from each other: a plugin's peer dependency on another
 * plugin must hold for the versions chosen. When it doesn't, the plugin required is held back if
 * it can be, so the plugins that need it keep working; otherwise the one requiring it is. Versions
 * only ever go down while settling, back to what is installed at worst, so it always ends.
 */
export function planUpdate(
  site: SitePackages,
  packuments: Readonly<Record<string, Packument | Unreachable>>,
  scope: UpdateScope = {},
): UpdatePlan {
  const linked = Object.keys(site.specs).filter(
    (name) => isLinked(site.specs[name]!) && (isCore(name) || site.plugins.includes(name)),
  )
  const installed = (name: string) => {
    const version = site.installed[name]
    if (!version)
      throw new Error(`${name} is not installed; run your package manager's install first`)
    return version
  }
  const coreFrom = installed(CORE_VERSION_FROM)
  const coreInScope = scope.only ? scope.only.some(isCore) : !scope.pluginsOnly
  const pluginInScope = (name: string) => (scope.only ? scope.only.includes(name) : true)

  const coreMove =
    coreInScope && !linked.includes(CORE_VERSION_FROM)
      ? planCore(site, packuments, scope)
      : { core: null, changes: [], blockers: [] }
  const coreTo = coreMove.core?.to ?? coreFrom
  const blockers = [...coreMove.blockers]
  const warnings: string[] = []

  const peersOf = (name: string, version: string): Record<string, string> => {
    if (version === site.installed[name]) return site.peers[name] ?? {}
    const doc = packuments[name]
    return (doc && !('error' in doc) && doc.versions[version]?.peerDependencies) || {}
  }

  // Each plugin's usable versions, newest first; the installed one is always the last resort.
  const options = new Map<string, string[]>()
  const latest = new Map<string, string | null>()
  for (const name of site.plugins) {
    const from = installed(name)
    const doc = packuments[name]
    if (doc && 'error' in doc)
      warnings.push(`Couldn't check ${name}: ${doc.error}. It stays at ${from}.`)
    if (linked.includes(name) || !pluginInScope(name) || !doc || 'error' in doc) {
      options.set(name, [from])
      continue
    }
    const newer = candidates(doc, from)
      .filter(
        (version) =>
          semver.gt(version, from) && (!scope.patchOnly || semver.satisfies(version, `~${from}`)),
      )
      .sort(semver.rcompare)
    latest.set(name, newer[0] ?? null)
    const usable = newer.filter((version) => {
      const support = coreSupport(peersOf(name, version), coreTo)
      return support === 'yes' || (support === 'unknown' && semver.satisfies(version, `^${from}`))
    })
    options.set(name, [...usable, from])
  }

  const chosen = new Map([...options].map(([name, list]) => [name, list[0]!]))
  const notes = new Map<string, string>()
  const unresolved = new Set<string>()
  for (let changed = true; changed;) {
    changed = false
    for (const a of site.plugins) {
      const va = chosen.get(a)!
      for (const [b, range] of Object.entries(peersOf(a, va))) {
        const vb = chosen.get(b)
        const pair = `${a} ${b}`
        if (vb === undefined || unresolved.has(pair)) continue
        if (semver.satisfies(vb, range, INCLUDE_PRERELEASE)) continue
        const lowerB = options
          .get(b)!
          .find((v) => semver.lt(v, vb) && semver.satisfies(v, range, INCLUDE_PRERELEASE))
        if (lowerB) {
          chosen.set(b, lowerB)
          notes.set(b, `${a} ${va} needs ${b} ${range}`)
          changed = true
          continue
        }
        const lowerA = options.get(a)!.find((v) => {
          const needs = peersOf(a, v)[b]
          return semver.lt(v, va) && (!needs || semver.satisfies(vb, needs, INCLUDE_PRERELEASE))
        })
        if (lowerA) {
          chosen.set(a, lowerA)
          notes.set(a, `${latest.get(a) ?? va} needs ${b} ${range}, and ${b} stays at ${vb}`)
          changed = true
          break
        }
        // Even the installed versions disagree: the site is already like this.
        unresolved.add(pair)
        warnings.push(`${a} ${va} needs ${b} ${range}, but ${b} is ${vb}.`)
      }
    }
  }

  const plugins: PluginReport[] = []
  const changes = [...coreMove.changes]
  for (const name of site.plugins.filter((n) => !linked.includes(n) && pluginInScope(n))) {
    const from = installed(name)
    const version = chosen.get(name)!
    const newest = latest.get(name) ?? null
    const compatible = coreSupport(peersOf(name, version), coreTo)
    let note = notes.get(name)
    if (!note && newest && version !== newest) {
      note =
        coreSupport(peersOf(name, newest), coreTo) === 'no'
          ? `${newest} needs a different core than ${coreTo}`
          : `${newest} is a new major version that doesn't say which core it supports`
    }
    plugins.push({
      name,
      from,
      to: version === from ? null : version,
      latest: newest,
      compatible,
      ...(note ? { note } : {}),
    })
    if (version !== from) changes.push({ name, from, to: version })
    if (compatible === 'no' && coreMove.core) {
      blockers.push(
        `${name} ${version} doesn't support core ${coreTo}, and no newer version does yet; it would be switched off.`,
      )
    }
  }
  // Out of scope, but they must still work with the new core.
  if (coreMove.core) {
    for (const name of site.plugins.filter((n) => !pluginInScope(n) && !linked.includes(n))) {
      if (coreSupport(peersOf(name, installed(name)), coreTo) === 'no') {
        blockers.push(
          `${name} ${installed(name)} doesn't support core ${coreTo}; update it too, or it would be switched off.`,
        )
      }
    }
  }
  return { core: coreMove.core, changes, plugins, blockers, warnings, linked }
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** What `planUpdate` needs from the site: specs, installed versions and the plugin list. */
export async function readSitePackages(root: string): Promise<SitePackages> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageJson
  const specs = { ...manifest.devDependencies, ...manifest.dependencies }
  const { plugins } = JSON.parse(await readFile(join(root, 'cms.config.json'), 'utf8')) as {
    plugins: string[]
  }
  const installed: Record<string, string> = {}
  const peers: Record<string, Record<string, string>> = {}
  for (const name of Object.keys(specs).filter((n) => isCore(n) || plugins.includes(n))) {
    const file = join(root, 'node_modules', ...name.split('/'), 'package.json')
    const found = await readFile(file, 'utf8').catch(() => null)
    if (!found) continue
    const pkg = JSON.parse(found) as PackageJson & { version: string }
    installed[name] = pkg.version
    peers[name] = pkg.peerDependencies ?? {}
  }
  return { specs, installed, peers, plugins }
}

/**
 * Plans an update for the site at `root`: reads what is installed, looks up what is published
 * (through npm, so `.npmrc` applies), and plans. `packages` are names as typed, resolved with
 * `resolveTargets`. What `cms update` and `cms serve` both run.
 */
export async function planSite(
  root: string,
  { packages = [], ...scope }: Omit<UpdateScope, 'only'> & { packages?: readonly string[] } = {},
  fetchVersions: FetchVersions = npmView(root),
): Promise<UpdatePlan> {
  const site = await readSitePackages(root)
  const only = packages.length > 0 ? resolveTargets(site, packages) : undefined
  const coreInScope = only ? only.some(isCore) : !scope.pluginsOnly
  const lookups = [
    ...(coreInScope ? CORE_PACKAGES.filter((name) => name in site.specs) : []),
    ...site.plugins.filter((name) => !only || only.includes(name)),
  ].filter((name) => site.specs[name] && !isLinked(site.specs[name]))
  // One plugin npm can't reach (a private registry without a token, say) doesn't stop the rest.
  const packuments: Record<string, Packument | Unreachable> = Object.fromEntries(
    await Promise.all(
      lookups.map(async (name) => {
        const found = await fetchVersions(name, site.installed[name] ?? '0.0.0').catch(
          (error: unknown): Unreachable => ({
            name,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        return [name, found] as const
      }),
    ),
  )
  return planUpdate(site, packuments, { ...scope, only })
}

/** Keeps the spec's style: `^1.2.0` stays a caret range, `1.2.0` stays exact. */
export function nextSpec(current: string, version: string): string {
  const prefix = /^[\^~]/.exec(current)?.[0] ?? ''
  return `${prefix}${version}`
}

/** Rewrites package.json in place, leaving everything else in it as it was. */
export async function writeChanges(
  root: string,
  changes: readonly UpdatePlan['changes'][number][],
): Promise<void> {
  const file = join(root, 'package.json')
  const raw = await readFile(file, 'utf8')
  const manifest = JSON.parse(raw) as PackageJson
  for (const { name, to } of changes) {
    for (const deps of [manifest.dependencies, manifest.devDependencies]) {
      if (deps?.[name]) deps[name] = nextSpec(deps[name], to)
    }
  }
  const indent = /^(\s+)"/m.exec(raw)?.[1] ?? '  '
  await writeFile(file, `${JSON.stringify(manifest, null, indent)}\n`)
}

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

/** From the lockfile next to package.json, or the nearest one above (workspaces). */
export async function detectPackageManager(root: string): Promise<PackageManager> {
  for (let dir = root; ; dir = join(dir, '..')) {
    for (const [file, manager] of LOCKFILES) {
      if (
        await access(join(dir, file)).then(
          () => true,
          () => false,
        )
      )
        return manager
    }
    if (join(dir, '..') === dir) return 'npm'
  }
}

export async function install(root: string, manager: PackageManager): Promise<void> {
  await run(manager, ['install'], { cwd: root })
}

/** `--commit`'s message, which the GitHub workflow makes the pull request's title. */
export function updateCommitMessage(brand: Brand, coreTarget: string | undefined): string {
  return coreTarget ? `Update ${brand.name} to ${coreTarget}` : `Update ${brand.name} plugins`
}

/** `--commit`: the change on its own branch, for hosts that build from git. */
export async function commitUpdate(root: string, branch: string, message: string): Promise<void> {
  const git = (...args: string[]) => run('git', args, { cwd: root })
  const status = await git('status', '--porcelain')
  if (!status.stdout.trim()) throw new Error('Nothing changed, so there is nothing to commit')
  await git('checkout', '-b', branch)
  // The whole repository: the lockfile may sit above the site, in a workspace. The caller made
  // sure the tree was clean, so this is only the update.
  await git('add', '--all')
  await git('commit', '--message', message)
}
