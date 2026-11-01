// Plain JavaScript: `npm create otw-cms` runs this straight from the registry, before anything
// that could compile TypeScript is installed.
import { cp, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const TEMPLATE = resolve(HERE, '../template')

/** @typedef {'pnpm' | 'npm' | 'yarn' | 'bun'} PackageManager */

/** The CMS's packages, released together with this scaffolder under one version. */
const CORE = ['@otw/next', '@otw/sdk', '@otw/admin-ui']
const CORE_DEV = ['@otw/cli']

/** Versions of what a site needs besides the CMS, tested with this release. */
const THIRD_PARTY = {
  '@electric-sql/pglite': '^0.5.13',
  'drizzle-orm': '^0.45.4',
  next: '^16.4.3',
  react: '^19.3.1',
  'react-dom': '^19.3.1',
}
const THIRD_PARTY_DEV = {
  '@types/node': '^24.0.0',
  '@types/react': '^19.3.0',
  '@types/react-dom': '^19.2.0',
  typescript: '~6.0.3',
}

/**
 * `commerce` means the first-party `@otw/plugin-commerce`; anything else is a package name.
 *
 * @param {string} name
 */
export function pluginPackage(name) {
  return name.startsWith('@') || name.includes('/') ? name : `@otw/plugin-${name}`
}

// npm's rules for new package names; they end up in package.json and generated source.
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** @param {string} dir */
export function siteName(dir) {
  const name = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
  if (!PACKAGE_NAME.test(name)) throw new Error(`Can't make a package name from "${dir}"`)
  return name
}

/** The package manager that ran us, from npm_config_user_agent (`pnpm/10.5.2 npm/? node/…`). */
export function detectPackageManager(userAgent = process.env.npm_config_user_agent ?? '') {
  const name = userAgent.split('/')[0] ?? ''
  return /** @type {PackageManager} */ (['pnpm', 'yarn', 'bun'].includes(name) ? name : 'npm')
}

/**
 * Each package manager's commands. `dockerRuntime` makes it available in the Dockerfile's final
 * stage (npm ships with Node); `dockerStart` is that stage's CMD.
 */
const COMMANDS = {
  pnpm: {
    run: 'pnpm',
    exec: 'pnpm',
    ciInstall: 'corepack enable && pnpm install --frozen-lockfile',
    dockerRuntime: 'corepack enable',
    dockerStart: '["pnpm", "start"]',
  },
  npm: {
    run: 'npm run',
    exec: 'npx',
    ciInstall: 'npm ci',
    dockerRuntime: '',
    dockerStart: '["npm", "start"]',
  },
  yarn: {
    run: 'yarn',
    exec: 'yarn',
    ciInstall: 'corepack enable && yarn install --immutable',
    dockerRuntime: 'corepack enable',
    dockerStart: '["yarn", "start"]',
  },
  bun: {
    run: 'bun run',
    exec: 'bunx',
    ciInstall: 'npm install --global bun && bun install --frozen-lockfile',
    dockerRuntime: 'npm install --global bun',
    dockerStart: '["bun", "run", "start"]',
  },
}

/** `{{run}}`-style placeholders in the template's text files. */
const PLACEHOLDER_FILES = ['README.md', '.github/workflows/cms-update.yml', 'Dockerfile']

/**
 * Where each CMS package lives in a checkout of the CMS, for `--link`: the site uses the
 * checkout's packages instead of the registry's, to try unreleased changes.
 *
 * @param {string} repo
 * @returns {Promise<Record<string, string>>}
 */
async function workspacePackages(repo) {
  /** @type {Record<string, string>} */
  const found = {}
  for (const group of ['packages', 'plugins']) {
    for (const dir of await readdir(join(repo, group))) {
      const manifest = await readFile(join(repo, group, dir, 'package.json'), 'utf8').catch(
        () => null,
      )
      if (manifest) found[JSON.parse(manifest).name] = join(repo, group, dir)
    }
  }
  return found
}

/**
 * Turbopack resolves only files under its root, so a site using a checkout's packages needs a
 * root above both. Only for `--link`: installed packages are inside the site.
 *
 * @param {string} target
 * @param {string} repo
 */
async function linkTurbopackRoot(target, repo) {
  const a = target.split(sep)
  const b = repo.split(sep)
  let shared = 0
  while (shared < a.length && a[shared] === b[shared]) shared++
  const root = a.slice(0, shared).join(sep) || sep
  const config = `import { withCms } from '@otw/next/config'

// Linked to a checkout of the CMS (create-otw-cms --link), so Turbopack's root must hold both.
const root = ${JSON.stringify(root)}

export default withCms({ turbopack: { root }, outputFileTracingRoot: root })
`
  await writeFile(join(target, 'next.config.ts'), config)
}

/**
 * @param {{
 *   name: string
 *   version: string
 *   plugins: string[]
 *   link?: Record<string, string>
 *   target: string
 * }} input
 */
function packageJson({ name, version, plugins, link, target }) {
  /** @param {string} pkg */
  const spec = (pkg) => {
    if (!link) return `^${version}`
    if (!link[pkg]) throw new Error(`${pkg} is not in the linked checkout`)
    return `link:${relative(target, link[pkg])}`
  }
  const sorted = (/** @type {Record<string, string>} */ deps) =>
    Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)))
  return {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'cms generate && next dev',
      build: 'cms generate && next build',
      // For several instances or serverless: migrate before the new version takes traffic.
      'build:deploy': 'cms generate && cms migrate --no-backup && next build',
      start: 'next start',
      typecheck: 'cms generate && next typegen && tsc --noEmit',
    },
    dependencies: sorted({
      ...Object.fromEntries([...CORE, ...plugins].map((pkg) => [pkg, spec(pkg)])),
      ...THIRD_PARTY,
    }),
    devDependencies: sorted({
      ...Object.fromEntries(CORE_DEV.map((pkg) => [pkg, spec(pkg)])),
      ...THIRD_PARTY_DEV,
    }),
  }
}

/**
 * Writes a new site into `target`, which must be empty or missing.
 *
 * @param {{
 *   target: string
 *   version: string
 *   plugins?: string[]
 *   packageManager?: PackageManager
 *   link?: string
 * }} options
 */
export async function scaffold({ target, version, plugins = [], packageManager = 'npm', link }) {
  const existing = await readdir(target).catch(() => [])
  if (existing.length > 0) throw new Error(`${target} is not empty`)
  const name = siteName(target)
  const packages = plugins.map(pluginPackage)
  const invalid = packages.find((pkg) => !PACKAGE_NAME.test(pkg))
  if (invalid) throw new Error(`Invalid plugin package name: ${invalid}`)

  await mkdir(target, { recursive: true })
  await cp(TEMPLATE, target, { recursive: true })
  // npm drops .gitignore from published packages, so the template ships it under another name.
  await rename(join(target, 'gitignore'), join(target, '.gitignore'))

  const commands = COMMANDS[packageManager]
  for (const file of PLACEHOLDER_FILES) {
    const path = join(target, file)
    await writeFile(
      path,
      (await readFile(path, 'utf8'))
        .replaceAll('{{name}}', name)
        .replaceAll('{{run}}', commands.run)
        .replaceAll('{{exec}}', commands.exec)
        .replaceAll('{{ci_install}}', commands.ciInstall)
        // A line of its own, dropped when the package manager needs nothing installed.
        .replace(
          /^\{\{docker_runtime\}\}\n/m,
          commands.dockerRuntime ? `RUN ${commands.dockerRuntime}\n` : '',
        )
        .replaceAll('{{docker_start}}', commands.dockerStart),
    )
  }
  const linked = link ? await workspacePackages(resolve(link)) : undefined
  if (link) await linkTurbopackRoot(resolve(target), resolve(link))
  const manifest = packageJson({
    name,
    version,
    plugins: packages,
    link: linked,
    target: resolve(target),
  })
  await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(
    join(target, 'cms.config.json'),
    `${JSON.stringify({ plugins: packages }, null, 2)}\n`,
  )
  return { name, commands }
}
