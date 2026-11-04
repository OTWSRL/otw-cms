import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { access } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import type { UpdateRequest } from '@otwdesign/core'
import { loadEnv } from '../site.ts'
import { detectPackageManager, planSite } from '../update.ts'
import { ControlError, createControlServer } from './control.ts'
import { startRelease } from './processes.ts'
import { createProxy } from './proxy.ts'
import { buildRelease, migrateRelease, removeRelease, writeBack } from './releases.ts'
import { backupDatabase, loadState, restoreDatabase, saveState } from './state.ts'
import { Supervisor, type Log } from './supervisor.ts'

const TWELVE_HOURS = 12 * 60 * 60 * 1000
const MAX_PACKAGES = 100

export interface ServeOptions {
  root: string
  port: number
  hostname: string
  /** For Postgres hosts that take their own backups; the embedded database is always copied. */
  backup: boolean
  checkEveryMs?: number
}

function parseUpdateRequest(body: unknown): UpdateRequest {
  const { packages, pluginsOnly } = (body ?? {}) as { packages?: unknown; pluginsOnly?: unknown }
  if (
    packages !== undefined &&
    (!Array.isArray(packages) ||
      packages.length > MAX_PACKAGES ||
      !packages.every((name) => typeof name === 'string' && name.length <= 214))
  ) {
    throw new ControlError(400, '"packages" must be a list of package names')
  }
  return { packages: packages as string[] | undefined, pluginsOnly: pluginsOnly === true }
}

async function standaloneSite(root: string): Promise<void> {
  const lockfiles = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']
  for (const file of lockfiles) {
    if (
      await access(join(root, file)).then(
        () => true,
        () => false,
      )
    )
      return
  }
  throw new Error(
    'cms serve runs a site with its own lockfile (as create-otw-cms makes them). Run it in the site’s directory, after installing.',
  )
}

/**
 * `cms serve`: runs the site from built releases behind a proxy on the public port, and applies
 * updates from the admin. Resolves once it is serving; stops on SIGINT or SIGTERM.
 */
export async function serve(options: ServeOptions): Promise<void> {
  const root = resolve(options.root)
  await standaloneSite(root)
  const env = loadEnv(root)
  const database = env.DATABASE_URL ? 'postgres' : 'embedded'
  const dataDir = resolve(root, env.CMS_DATA_DIR || '.data/pglite')
  const stateFile = join(root, '.cms', 'state.json')
  const manager = await detectPackageManager(root)
  const builder = { site: root, manager, releasesDir: join(root, '.cms', 'releases') }
  const token = randomBytes(32).toString('hex')
  const output: Log = (line) => console.log(line)

  // Bound first, so releases can be told where it is.
  const routes: Record<string, (body: unknown) => unknown> = {}
  const control = createControlServer(token, routes)
  control.listen(0, '127.0.0.1')
  await once(control, 'listening')
  const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`
  const releaseEnv = {
    CMS_SUPERVISOR_URL: controlUrl,
    CMS_SUPERVISOR_TOKEN: token,
    // The proxy in front is ours: the visitor's origin comes from its X-Forwarded headers.
    CMS_TRUST_PROXY: '1',
    // Every release uses the site's database and uploads, wherever its own copy of the code is.
    ...(database === 'embedded' ? { CMS_DATA_DIR: dataDir } : {}),
    CMS_UPLOADS_DIR: resolve(root, env.CMS_UPLOADS_DIR || '.data/uploads'),
  }

  const supervisor = new Supervisor(
    await loadState(stateFile),
    {
      plan: (release, scope) => planSite(release.dir, scope),
      build: (id, changes, log) => buildRelease(builder, id, changes, log),
      migrate: (release, log) =>
        migrateRelease(release, log, {
          site: root,
          siteEnv: env,
          backup: options.backup,
          releaseEnv,
        }),
      backup: async () =>
        database === 'embedded'
          ? backupDatabase(dataDir, join(root, '.cms', 'backups'), new Date())
          : null,
      restore: (backup) => restoreDatabase(backup, dataDir),
      start: (release, log) => startRelease(release, log, { env: releaseEnv, output }),
      writeBack: async (release, changes) => {
        const skipped = await writeBack(builder, release, changes)
        if (skipped.length > 0) {
          output(`cms: not copied back to the site (local package links): ${skipped.join(', ')}`)
        }
      },
      remove: removeRelease,
      save: (state) => saveState(stateFile, state),
      now: () => new Date(),
    },
    { database },
  )

  Object.assign(routes, {
    'GET /status': () => supervisor.overview(),
    'POST /check': async () => ({ notice: await supervisor.check() }),
    'POST /update': (body: unknown) => ({ notice: supervisor.update(parseUpdateRequest(body)) }),
    'POST /rollback': (body: unknown) => {
      const release = (body as { release?: unknown } | null)?.release
      if (typeof release !== 'string') throw new ControlError(400, '"release" is required')
      return { notice: supervisor.rollback(release) }
    },
    'PUT /auto-update': async (body: unknown) => {
      const mode = (body as { mode?: unknown } | null)?.mode
      if (mode !== 'off' && mode !== 'patch') {
        throw new ControlError(400, '"mode" must be "off" or "patch"')
      }
      return { notice: await supervisor.setAutoUpdate(mode) }
    },
  })

  await supervisor.start(output)
  const proxy = createProxy(() => supervisor.target())
  proxy.listen(options.port, options.hostname)
  await once(proxy, 'listening')
  output(`cms: serving on http://${options.hostname}:${options.port} (${database} database)`)

  const timer = setInterval(() => {
    supervisor
      .tick()
      .catch((error: unknown) => output(`cms: update check failed: ${String(error)}`))
  }, options.checkEveryMs ?? TWELVE_HOURS)

  const shutdown = async () => {
    clearInterval(timer)
    output('cms: stopping')
    proxy.close()
    control.close()
    await supervisor.stop()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}
