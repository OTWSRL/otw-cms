import type { Database, Logger, PluginDefinition } from '@otw/sdk'
import { and, eq, sql } from 'drizzle-orm'
import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import type { DatabaseContext } from './database'
import { PluginBootError } from './errors'

export const cmsMigrations = pgTable(
  'cms_migrations',
  {
    pluginId: text('plugin_id').notNull(),
    migrationId: text('migration_id').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.migrationId] })],
)

// Serialises migrations across processes booting at the same time (e.g. several app instances).
const MIGRATION_LOCK = 727_001

const lock = sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`

export async function runMigrations(
  db: DatabaseContext,
  plugins: readonly PluginDefinition[],
  logger: Logger,
): Promise<string[]> {
  await db.transaction(async (tx) => {
    await tx.execute(lock)
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS cms_migrations (
        plugin_id text NOT NULL,
        migration_id text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (plugin_id, migration_id)
      )
    `)
  })

  const rows = await db.root.select().from(cmsMigrations)
  const applied = new Set(rows.map((row) => `${row.pluginId}/${row.migrationId}`))
  const ran: string[] = []

  for (const plugin of plugins) {
    for (const migration of plugin.migrations ?? []) {
      const key = `${plugin.id}/${migration.id}`
      if (applied.has(key)) continue
      try {
        const didRun = await db.transaction(async (tx) => {
          await tx.execute(lock)
          // Another process may have applied it while we waited for the lock.
          const done = await tx
            .select()
            .from(cmsMigrations)
            .where(
              and(
                eq(cmsMigrations.pluginId, plugin.id),
                eq(cmsMigrations.migrationId, migration.id),
              ),
            )
          if (done.length > 0) return false
          await migration.up(tx)
          await tx.insert(cmsMigrations).values({ pluginId: plugin.id, migrationId: migration.id })
          return true
        })
        if (didRun) {
          ran.push(key)
          logger.info(`Applied migration ${key}`)
        }
      } catch (error) {
        throw new PluginBootError(plugin.id, 'migrate', error)
      }
    }
  }
  return ran
}

/** `pluginId/migrationId` for each migration not yet applied, in run order. Reads only. */
export async function pendingMigrations(
  db: DatabaseContext,
  plugins: readonly PluginDefinition[],
): Promise<string[]> {
  const rows = (await tableExists(db.root, 'cms_migrations'))
    ? await db.root.select().from(cmsMigrations)
    : []
  const applied = new Set(rows.map((row) => `${row.pluginId}/${row.migrationId}`))
  return plugins.flatMap((plugin) =>
    (plugin.migrations ?? [])
      .map((migration) => `${plugin.id}/${migration.id}`)
      .filter((key) => !applied.has(key)),
  )
}

/** Whether a table exists yet, without creating anything (for read-only checks). */
export async function tableExists(db: Database, table: string): Promise<boolean> {
  // node-postgres and PGlite both answer with { rows }; Drizzle's type can't know which.
  const result = (await db.execute(sql`SELECT to_regclass(${table}) AS name`)) as {
    rows: { name: string | null }[]
  }
  return result.rows[0]?.name != null
}
