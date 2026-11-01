import { execFile } from 'node:child_process'
import { access, cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { migrateSite, type Env } from '@otw/core'
import type { Site } from '@otw/next'
import { activePluginsFromEnv, dataDir, openDatabase } from '@otw/next/server'
import type { Logger } from '@otw/sdk'

const run = promisify(execFile)

export interface MigrateOptions {
  /** The site's directory. Postgres backups go in its `.data/backups`. */
  root: string
  env: Env
  site: Site
  logger: Logger
  /** List pending migrations and change nothing. */
  dryRun?: boolean
  /** Skip the backup, for hosts that take their own (most managed Postgres does). */
  backup?: boolean
  now?: () => Date
  /** Whether `pg_dump` can run; replaced in tests. */
  hasPgDump?: () => Promise<boolean>
}

export type MigrateResult = { pending: string[] } | { applied: string[]; backup: string | null }

async function pgDumpAvailable(): Promise<boolean> {
  return run('pg_dump', ['--version']).then(
    () => true,
    () => false,
  )
}

/**
 * Copies the embedded database's directory, or dumps Postgres with `pg_dump`. The password goes
 * through the environment, not the command line, where other users could read it.
 */
async function backUp(options: MigrateOptions): Promise<string | null> {
  const { env, root } = options
  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')
  if (env.DATABASE_URL) {
    const dir = join(root, '.data', 'backups')
    if (!(await (options.hasPgDump ?? pgDumpAvailable)())) {
      throw new Error(
        'pg_dump is not installed, so the database cannot be backed up first. Take a backup (many hosts do this for you), then run `cms migrate --no-backup`.',
      )
    }
    const url = new URL(env.DATABASE_URL)
    const password = decodeURIComponent(url.password)
    url.password = ''
    const file = join(dir, `postgres-${stamp}.dump`)
    await mkdir(dir, { recursive: true })
    await run('pg_dump', ['--format=custom', `--file=${file}`, url.toString()], {
      env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) },
    })
    return file
  }
  const source = dataDir(env)
  const exists = await access(source).then(
    () => true,
    () => false,
  )
  // A site that never started has nothing to lose.
  if (!exists) return null
  // Beside the database, so it shares its disk (the volume, in a container).
  const target = join(dirname(source), 'backups', `pglite-${stamp}`)
  await cp(source, target, { recursive: true, errorOnExist: true, force: false })
  return target
}

/** `cms migrate`: back up, then run core's and the active plugins' pending migrations. */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const backup = options.dryRun || options.backup === false ? null : await backUp(options)
  const handle = openDatabase(options.env, { create: !options.dryRun })
  try {
    const result = await migrateSite({
      db: handle.db,
      plugins: options.site.plugins,
      active: activePluginsFromEnv(options.env),
      logger: options.logger,
      dryRun: options.dryRun,
    })
    return 'pending' in result ? result : { applied: result.applied, backup }
  } finally {
    await handle.close()
  }
}
