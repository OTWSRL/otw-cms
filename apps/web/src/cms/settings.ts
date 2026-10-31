import type { Env } from '@cms/core'

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
