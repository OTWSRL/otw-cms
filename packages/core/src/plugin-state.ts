import type { Database, PluginDefinition } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import semver from 'semver'
import { pluginStates } from './core-schema'
import { markPluginsInitialized } from './options'
import { validatePlugin } from './resolver'

const CORE = 'core'

/**
 * The plugins the site has switched on. On first boot every installed plugin starts active;
 * plugins installed later start inactive, as in WordPress.
 *
 * The first boot is recorded, so a site that started with no plugins and gets its first one
 * later doesn't mistake that for it. `initialized` is what the caller already read of that
 * record (a booting kernel reads it with its generation); without it, it's looked up, but only
 * when no plugin is on record, which is when it matters.
 */
export async function loadActiveIds(
  db: Database,
  installed: readonly PluginDefinition[],
  initialized?: boolean,
): Promise<string[]> {
  let rows = await db.select().from(pluginStates)
  if (initialized === true) return rows.filter((row) => row.active).map((row) => row.id)
  // A site from before the record existed has plugins on record: it has booted before.
  const first = (await markPluginsInitialized(db)) && rows.length === 0
  if (first && installed.length > 0) {
    await db
      .insert(pluginStates)
      .values(installed.map((plugin) => ({ id: plugin.id, active: true })))
      .onConflictDoNothing()
    rows = await db.select().from(pluginStates)
  }
  return rows.filter((row) => row.active).map((row) => row.id)
}

export async function saveActive(db: Database, id: string, active: boolean): Promise<void> {
  await db
    .insert(pluginStates)
    .values({ id, active })
    .onConflictDoUpdate({ target: pluginStates.id, set: { active, updatedAt: sql`now()` } })
}

export function displayName(plugin: PluginDefinition | undefined, id: string): string {
  return plugin?.name ?? id
}

/** Why `plugin` can't be activated next to `active`, as sentences for the admin. */
export function activationBlockers(
  plugin: PluginDefinition,
  installed: ReadonlyMap<string, PluginDefinition>,
  active: ReadonlySet<string>,
  coreVersion: string,
): string[] {
  const errors = validatePlugin(plugin)
  if (errors.length > 0) return [`Invalid plugin definition: ${errors.join('; ')}.`]

  const blockers: string[] = []
  for (const [dep, range] of Object.entries(plugin.requires ?? {})) {
    if (dep === CORE) {
      if (!semver.satisfies(coreVersion, range, { includePrerelease: true })) {
        blockers.push(`Requires core ${range}; this site runs ${coreVersion}.`)
      }
      continue
    }
    const target = installed.get(dep)
    if (!target) {
      blockers.push(`Requires "${dep}", which is not installed.`)
    } else if (!semver.satisfies(target.version, range, { includePrerelease: true })) {
      blockers.push(
        `Requires ${displayName(target, dep)} ${range}; ${target.version} is installed.`,
      )
    } else if (!active.has(dep)) {
      blockers.push(`Activate ${displayName(target, dep)} first.`)
    }
  }
  return blockers
}

/** Active plugins that require `id` have to go first, so nothing is left half-working. */
export function deactivationBlockers(
  id: string,
  installed: readonly PluginDefinition[],
  active: ReadonlySet<string>,
): string[] {
  return installed
    .filter((plugin) => plugin.id !== id && active.has(plugin.id) && id in (plugin.requires ?? {}))
    .map((plugin) => `${displayName(plugin, plugin.id)} requires it. Deactivate that first.`)
}
