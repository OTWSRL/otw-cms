import type { Env } from '@otw/core'

/**
 * `CMS_ACTIVE_PLUGINS` pins the active plugins and turns off activation in the admin. Unset,
 * activation lives in the database and every installed plugin starts active on first boot.
 */
export function activePluginsFromEnv(env: Env): string[] | undefined {
  const raw = env.CMS_ACTIVE_PLUGINS?.trim()
  if (!raw) return undefined
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

const MIGRATION_MODES = ['startup', 'deploy'] as const
export type MigrationMode = (typeof MIGRATION_MODES)[number]

/**
 * `CMS_MIGRATIONS`: `startup` (the default) migrates when the site boots, for one server;
 * `deploy` leaves it to `cms migrate` in the deploy step, for several instances or serverless.
 */
export function migrationModeFromEnv(env: Env): MigrationMode {
  const raw = env.CMS_MIGRATIONS?.trim() || 'startup'
  const mode = MIGRATION_MODES.find((value) => value === raw)
  if (!mode) throw new Error(`CMS_MIGRATIONS must be "startup" or "deploy", not "${raw}"`)
  return mode
}
