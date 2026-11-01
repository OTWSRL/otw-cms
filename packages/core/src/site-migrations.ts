import type { Database, Logger, PluginDefinition } from '@otw/sdk'
import { getTableName } from 'drizzle-orm'
import { coreDefinition } from './core-plugin'
import { pluginStates } from './core-schema'
import { DatabaseContext } from './database'
import { createMemoryLogger } from './logger'
import { pendingMigrations, runMigrations, tableExists } from './migrations'
import { loadActiveIds } from './plugin-state'
import { resolvePlugins } from './resolver'
import { CORE_VERSION } from './version'

/** Core's own migrations haven't run, so the site can't start; `cms migrate` fixes it. */
export class DatabaseUpdateRequiredError extends Error {
  readonly pending: readonly string[]

  constructor(pending: readonly string[]) {
    super(
      `The database needs updating before the site can start: run \`cms migrate\`. Pending: ${pending.join(', ')}.`,
    )
    this.name = 'DatabaseUpdateRequiredError'
    this.pending = pending
  }
}

export interface MigrateSiteOptions {
  db: Database
  /** The installed plugins. Only the active ones migrate; the rest do when switched on. */
  plugins: readonly PluginDefinition[]
  /** Pins the active plugins, as `CMS_ACTIVE_PLUGINS` does. Otherwise read from the database. */
  active?: readonly string[]
  logger?: Logger
  coreVersion?: string
  /** List what would run, and change nothing. */
  dryRun?: boolean
}

export type MigrateSiteResult = { applied: string[] } | { pending: string[] }

/**
 * Without touching the database: the active plugins, or every installed one when the site has
 * never booted (first boot switches them all on).
 */
async function knownActiveIds(
  db: DatabaseContext,
  plugins: readonly PluginDefinition[],
): Promise<string[]> {
  const rows = (await tableExists(db.root, getTableName(pluginStates)))
    ? await db.root.select().from(pluginStates)
    : []
  return rows.length === 0
    ? plugins.map((plugin) => plugin.id)
    : rows.filter((row) => row.active).map((row) => row.id)
}

/**
 * What `cms migrate` and the admin's Update database button run: core's migrations, then the
 * active plugins' in load order. Each runs once, under a lock shared with booting instances.
 */
export async function migrateSite(options: MigrateSiteOptions): Promise<MigrateSiteResult> {
  const db = new DatabaseContext(options.db)
  const logger = options.logger ?? createMemoryLogger()
  const coreVersion = options.coreVersion ?? CORE_VERSION
  const order = (active: readonly string[]) =>
    resolvePlugins(options.plugins, active, coreVersion).order

  if (options.dryRun) {
    const active = options.active ?? (await knownActiveIds(db, options.plugins))
    return { pending: await pendingMigrations(db, [coreDefinition, ...order(active)]) }
  }
  const applied = await runMigrations(db, [coreDefinition], logger)
  const active = options.active ?? (await loadActiveIds(db.root, options.plugins))
  applied.push(...(await runMigrations(db, order(active), logger)))
  return { applied }
}
