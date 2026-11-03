import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Env } from '@otwdesign/core'
import type { Site } from '@otwdesign/next'
import nextEnv from '@next/env'
import { generate, siteModulePath } from './generate.ts'

/**
 * The site's environment as Next.js would see it: `.env`, `.env.production` and their `.local`
 * variants (or `.env.development` when NODE_ENV says so), under the real environment.
 */
export function loadEnv(root: string): Env {
  const quiet = { info: () => {}, error: console.error }
  return nextEnv.loadEnvConfig(root, process.env.NODE_ENV === 'development', quiet).combinedEnv
}

/** Regenerates the site module from cms.config.json, then loads it with the installed plugins. */
export async function loadSite(root: string): Promise<Site> {
  await generate({ root })
  const srcDir = await access(join(root, 'src', 'app')).then(
    () => 'src' as const,
    () => '' as const,
  )
  const file = join(root, ...siteModulePath({ srcDir }).split('/'))
  const module = (await import(pathToFileURL(file).href)) as { site?: Site }
  if (!module.site) throw new Error(`${file} does not export a site; run \`cms generate\``)
  return module.site
}
