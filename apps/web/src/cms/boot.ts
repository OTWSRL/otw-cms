import { createKernel, type Env, type Kernel } from '@cms/core'
import type { Database } from '@cms/sdk'
import { installedPlugins } from './plugins.generated'
import { activePluginsFromEnv } from './settings'

export interface BootOptions {
  env?: Env
  /** Called after an admin changes activation or settings. */
  onChange?: () => void
}

export function bootKernel(
  db: Database,
  { env = process.env, onChange }: BootOptions = {},
): Promise<Kernel> {
  return createKernel({
    plugins: installedPlugins,
    active: activePluginsFromEnv(env),
    db,
    env,
    secret: env.CMS_SECRET || undefined,
    onChange,
  })
}
