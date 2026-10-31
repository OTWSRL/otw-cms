import { spawn } from 'node:child_process'
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PackageChange } from '@cms/core'
import { MARKER } from '../generate.ts'
import { CORE_PACKAGES, readSitePackages, writeChanges, type PackageManager } from '../update.ts'
import type { BuiltRelease, Log } from './supervisor.ts'

/** Built, installed or local state: never copied into a release, never copied back. */
const NOT_SOURCE = new Set([
  'node_modules',
  '.next',
  '.cms',
  '.data',
  '.git',
  'coverage',
  'test-results',
  'playwright-report',
])

const LOCKFILES: Record<PackageManager, string[]> = {
  pnpm: ['pnpm-lock.yaml'],
  npm: ['package-lock.json'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
}

function isSource(site: string, path: string): boolean {
  const top = relative(site, path).split(sep)[0]
  return top === '' || !NOT_SOURCE.has(top!)
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * A release lives deeper than the site, so `link:../x` and `file:../x` would point elsewhere:
 * make them absolute. Returns whether any were, since such a lockfile can't go back to the site.
 */
async function anchorLocalSpecs(site: string, dir: string): Promise<boolean> {
  const file = join(dir, 'package.json')
  const manifest = JSON.parse(await readFile(file, 'utf8')) as PackageJson
  let changed = false
  for (const deps of [manifest.dependencies, manifest.devDependencies]) {
    for (const [name, spec] of Object.entries(deps ?? {})) {
      const local = /^(link|file):(.+)$/.exec(spec)
      if (local && !isAbsolute(local[2]!)) {
        deps![name] = `${local[1]}:${resolve(site, local[2]!)}`
        changed = true
      }
    }
  }
  if (changed) await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return changed
}

/** Runs a command, streaming its output into the job's log, so a slow install shows it is alive. */
export function step(
  command: string,
  args: string[],
  cwd: string,
  log: Log,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  log(`$ ${command} ${args.join(' ')}`)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [child.stdout, child.stderr]) {
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        const lines = (pending + chunk).split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) log(line)
      })
      stream.on('end', () => pending && log(pending))
    }
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} ${args[0]} exited with ${code}`)),
    )
  })
}

function installArgs(manager: PackageManager): string[] {
  // The release is a standalone copy, even inside a workspace's tree; and package.json just changed.
  return manager === 'pnpm'
    ? ['install', '--ignore-workspace', '--no-frozen-lockfile']
    : ['install']
}

export interface ReleaseBuilder {
  site: string
  manager: PackageManager
  /** `.cms/releases` under the site. */
  releasesDir: string
}

/** Copies the site, applies the update, installs and builds: a release ready to start. */
export async function buildRelease(
  { site, manager, releasesDir }: ReleaseBuilder,
  id: string,
  changes: readonly PackageChange[],
  log: Log,
): Promise<BuiltRelease> {
  const dir = join(releasesDir, id)
  try {
    // Entry by entry: Node won't copy a directory into itself, even past a filter, and
    // releases live inside the site.
    await mkdir(dir, { recursive: true })
    for (const entry of await readdir(site)) {
      if (NOT_SOURCE.has(entry)) continue
      await cp(join(site, entry), join(dir, entry), { recursive: true })
    }
    await anchorLocalSpecs(site, dir)
    if (changes.length > 0) await writeChanges(dir, changes)
    await step(manager, installArgs(manager), dir, log)
    await step(manager, ['run', 'build'], dir, log)
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  const { installed, plugins } = await readSitePackages(dir)
  const versions = Object.fromEntries(
    Object.entries(installed).filter(
      ([name]) => plugins.includes(name) || (CORE_PACKAGES as readonly string[]).includes(name),
    ),
  )
  return { id, dir, createdAt: new Date().toISOString(), versions }
}

/** Files `cms generate` owns in a tree, relative to it. */
async function managedFiles(root: string, dir = root): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (!isSource(root, path)) continue
    if (entry.isDirectory()) found.push(...(await managedFiles(root, path)))
    else if (/\.tsx?$/.test(entry.name)) {
      const head = (await readFile(path, 'utf8')).slice(0, MARKER.length)
      if (head === MARKER) found.push(relative(root, path))
    }
  }
  return found
}

/**
 * After a switch, the site's own copy should say what runs: the new versions in package.json,
 * the lockfile, and the route files the new CLI wrote. Files the site owns (no marker) stay.
 * Returns what it couldn't copy, to tell the administrator.
 */
export async function writeBack(
  { site, manager }: ReleaseBuilder,
  release: BuiltRelease,
  changes: readonly PackageChange[],
): Promise<string[]> {
  const skipped: string[] = []
  if (changes.length > 0) await writeChanges(site, changes)
  const anchored = await readFile(join(release.dir, 'package.json'), 'utf8').then((raw) =>
    /"(link|file):\//.test(raw),
  )
  for (const lockfile of LOCKFILES[manager]) {
    const from = join(release.dir, lockfile)
    // A lockfile with the release's absolute local paths would be wrong in the site.
    if (anchored) {
      skipped.push(lockfile)
      continue
    }
    await copyFile(from, join(site, lockfile)).catch(() => {})
  }
  for (const file of await managedFiles(release.dir)) {
    const target = join(site, file)
    const current = await readFile(target, 'utf8').catch(() => null)
    if (current !== null && !current.startsWith(MARKER)) continue
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(release.dir, file), target)
  }
  return skipped
}

export async function removeRelease(release: BuiltRelease): Promise<void> {
  await rm(release.dir, { recursive: true, force: true })
}
