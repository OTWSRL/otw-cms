import { resolve } from 'node:path'
import type { Env } from '@otwdesign/core'

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
/** When migrations run: `startup` or `deploy`, from `CMS_MIGRATIONS`. */
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

/** Where uploads go when `CMS_UPLOADS_DIR` isn't set, relative to the site. */
export const DEFAULT_UPLOADS_DIR = '.data/uploads'

/**
 * `CMS_UPLOADS_DIR`: where uploads are kept on disk (`.data/uploads`), unless a plugin provides
 * storage. `CMS_MAX_UPLOAD_MB`: the largest file one upload may be (64), as PHP's
 * `upload_max_filesize` limits WordPress.
 */
export function uploadsFromEnv(env: Env): { dir: string; maxBytes: number } {
  const raw = env.CMS_MAX_UPLOAD_MB?.trim() || '64'
  const megabytes = Number(raw)
  if (!/^\d+(\.\d+)?$/.test(raw) || megabytes <= 0 || megabytes > 10_240) {
    throw new Error(
      `CMS_MAX_UPLOAD_MB must be a number of megabytes above 0, up to 10240, not "${raw}"`,
    )
  }
  return {
    // Runtime data, not a build input: keep the bundler from tracing the whole project.
    dir: resolve(/* turbopackIgnore: true */ env.CMS_UPLOADS_DIR || DEFAULT_UPLOADS_DIR),
    maxBytes: Math.round(megabytes * 1024 * 1024),
  }
}
