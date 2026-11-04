// Plain JavaScript: Node loads next.config before anything is compiled, and once installed from
// npm this file sits in node_modules, where Node won't strip TypeScript.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The CMS's own packages ship TypeScript source, so Next compiles them like app code. */
export const CORE_PACKAGES = [
  '@otwdesign/sdk',
  '@otwdesign/core',
  '@otwdesign/admin-ui',
  '@otwdesign/next',
]

/**
 * @param {string} file
 * @returns {string[]}
 */
function installedPlugins(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const plugins = config?.plugins
  if (!Array.isArray(plugins) || !plugins.every((name) => typeof name === 'string')) {
    throw new Error(`${file}: "plugins" must be a list of package names`)
  }
  return plugins
}

/**
 * @param {readonly string[] | undefined} current
 * @param {readonly string[]} added
 */
const merge = (current, added) => [...new Set([...(current ?? []), ...added])]

/**
 * The Next.js settings a CMS site needs, merged into the site's own. With `CMS_STANDALONE=1`, as
 * the site's Dockerfile builds, Next.js writes a standalone server: only the files the site runs
 * on, for a small image.
 *
 * @param {import('next').NextConfig} [nextConfig]
 * @param {{ config?: string, env?: Record<string, string | undefined> }} [options] where
 *   cms.config.json is, from the working directory, and the environment to read
 * @returns {import('next').NextConfig}
 */
export function withCms(nextConfig = {}, { config = 'cms.config.json', env = process.env } = {}) {
  const plugins = installedPlugins(resolve(process.cwd(), config))
  const standalone = ['1', 'true'].includes(env.CMS_STANDALONE ?? '')
  return {
    ...(standalone ? { output: 'standalone' } : {}),
    ...nextConfig,
    // Installed plugins ship TypeScript source too.
    transpilePackages: merge(nextConfig.transpilePackages, [...CORE_PACKAGES, ...plugins]),
    // PGlite loads its WebAssembly from its own package directory at runtime.
    serverExternalPackages: merge(nextConfig.serverExternalPackages, ['@electric-sql/pglite']),
    experimental: {
      ...nextConfig.experimental,
      // forbidden() answers admin pages a user may not open with a real 403.
      authInterrupts: true,
    },
  }
}
