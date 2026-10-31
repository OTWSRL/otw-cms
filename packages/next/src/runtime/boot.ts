import { createKernel, type Env, type Kernel } from '@cms/core'
import type { Database } from '@cms/sdk'
import type { Site } from '../site-registry'
import { activePluginsFromEnv, migrationModeFromEnv } from './settings'

export interface BootOptions {
  env?: Env
  /** Called after an admin changes activation or settings. */
  onChange?: () => void
}

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
    onChange,
  })
}
