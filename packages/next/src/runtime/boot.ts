import { createKernel, type Env, type Kernel } from '@otwdesign/core'
import type { Database } from '@otwdesign/sdk'
import type { Site } from '../site-registry'
import { activePluginsFromEnv, migrationModeFromEnv, uploadsFromEnv } from './settings'
import { traceCollector } from './tracing'
import { updateServiceFromEnv } from './updates'

/** How `bootSite()` reads the environment, and what it tells the app. */
export interface BootOptions {
  env?: Env
  /** Called after an admin changes activation or settings. */
  onChange?: () => void
  /** Called when a job is queued, with the time it's due: the app wakes what runs its jobs. */
  onJobQueued?: (dueAt: Date) => void
}

/**
 * Boots the site's kernel on a database, configured from the environment as the app is. For
 * scripts that run outside Next.js, such as seeding.
 */
export function bootSite(
  site: Site,
  db: Database,
  { env = process.env, onChange, onJobQueued }: BootOptions = {},
): Promise<Kernel> {
  return createKernel({
    plugins: site.plugins,
    admin: site.admin,
    active: activePluginsFromEnv(env),
    migrations: migrationModeFromEnv(env),
    db,
    env,
    secret: env.CMS_SECRET || undefined,
    trustProxy: ['1', 'true'].includes(env.CMS_TRUST_PROXY ?? ''),
    updates: updateServiceFromEnv(env),
    routes: site.routes,
    traces: traceCollector(),
    brand: site.brand,
    uploads: uploadsFromEnv(env),
    onChange,
    onJobQueued,
  })
}
