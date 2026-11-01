import { createKernel, type Env, type Kernel } from '@otw/core'
import type { Database } from '@otw/sdk'
import type { Site } from '../site-registry'
import { activePluginsFromEnv, migrationModeFromEnv } from './settings'
import { updateServiceFromEnv } from './updates'

/** How `bootSite()` reads the environment, and what it tells the app. */
export interface BootOptions {
  env?: Env
  /** Called after an admin changes activation or settings. */
  onChange?: () => void
}

/**
 * Boots the site's kernel on a database, configured from the environment as the app is. For
 * scripts that run outside Next.js, such as seeding.
 */
export function bootSite(
  site: Site,
  db: Database,
  { env = process.env, onChange }: BootOptions = {},
): Promise<Kernel> {
  return createKernel({
    plugins: site.plugins,
    active: activePluginsFromEnv(env),
    migrations: migrationModeFromEnv(env),
    db,
    env,
    secret: env.CMS_SECRET || undefined,
    trustProxy: ['1', 'true'].includes(env.CMS_TRUST_PROXY ?? ''),
    updates: updateServiceFromEnv(env),
    routes: site.routes,
    brand: site.brand,
    onChange,
  })
}
