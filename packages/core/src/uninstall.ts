import type { Logger, PluginDefinition } from '@otwdesign/sdk'
import { and, count, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { cache, jobs, storedSettings } from './core-schema'
import type { DatabaseContext } from './database'
import { cmsMigrations, MIGRATION_LOCK } from './migrations'
import { declaredSettings } from './settings'

/** What deleting a plugin's data would remove, for the screen that asks first. */
export interface UninstallPlan {
  /** Whether the plugin says how to remove what it made: its tables, its entries. */
  removesItsOwn: boolean
  /** Its migrations on record, forgotten when it removes its tables, so they run again. */
  migrations: number
  /** Its settings saved in the admin. */
  settings: number
  /** Its jobs, waiting and finished. */
  jobs: number
  /** Its durable cached values. */
  cached: number
}

/** Rows whose name starts with the plugin's id and `separator`, by a range an index answers. */
const owned = (column: typeof jobs.name | typeof cache.key, id: string, separator: '.' | ':') =>
  and(
    gte(column, `${id}${separator}`),
    // The character after the separator: "shop/" follows every "shop.…", "shop;" every "shop:…".
    lt(column, `${id}${String.fromCharCode(separator.charCodeAt(0) + 1)}`),
  )

const settingKeys = (plugin: PluginDefinition): string[] =>
  declaredSettings(plugin.id, plugin.settings).map((setting) => setting.key)

export async function uninstallPlan(
  db: DatabaseContext,
  plugin: PluginDefinition,
): Promise<UninstallPlan> {
  const keys = settingKeys(plugin)
  const one = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0
  const [migrations, settings, queued, cached] = await Promise.all([
    one(
      db.root
        .select({ n: count() })
        .from(cmsMigrations)
        .where(eq(cmsMigrations.pluginId, plugin.id)),
    ),
    keys.length === 0
      ? 0
      : one(
          db.root
            .select({ n: count() })
            .from(storedSettings)
            .where(inArray(storedSettings.key, keys)),
        ),
    one(
      db.root
        .select({ n: count() })
        .from(jobs)
        .where(owned(jobs.name, plugin.id, '.')),
    ),
    one(
      db.root
        .select({ n: count() })
        .from(cache)
        .where(owned(cache.key, plugin.id, ':')),
    ),
  ])
  return {
    removesItsOwn: typeof plugin.uninstall === 'function',
    migrations,
    settings,
    jobs: queued,
    cached,
  }
}

/**
 * Deletes what a plugin left in the database, like WordPress's uninstall: first what the plugin
 * itself removes (`uninstall()`: its tables, its entries), then what core kept for it. In one
 * transaction, so a plugin whose `uninstall()` fails keeps everything.
 */
export async function uninstallPlugin(
  db: DatabaseContext,
  plugin: PluginDefinition,
  logger: Logger,
): Promise<void> {
  const keys = settingKeys(plugin)
  await db.transaction(async (tx) => {
    // Not while a migration runs, here or on another server.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`)
    if (plugin.uninstall) {
      await plugin.uninstall({
        plugin: { id: plugin.id, version: plugin.version },
        db: tx,
        logger,
      })
      // Its tables are gone: activated again, it makes them again.
      await tx.delete(cmsMigrations).where(eq(cmsMigrations.pluginId, plugin.id))
    }
    if (keys.length > 0) await tx.delete(storedSettings).where(inArray(storedSettings.key, keys))
    await tx.delete(jobs).where(owned(jobs.name, plugin.id, '.'))
    await tx.delete(cache).where(owned(cache.key, plugin.id, ':'))
    // Its row in cms_plugins stays, switched off: a site with no rows at all is a new site,
    // whose first boot switches every plugin on.
  })
}
