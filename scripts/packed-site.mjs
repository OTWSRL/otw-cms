// A site as a user gets one: every publishable package packed as npm would publish it, a site
// made by the packed scaffolder, installed with npm from those tarballs, then type-checked and
// built. It catches what the workspace hides, where every package's devDependencies are
// installed: a type package, a file or a dependency the published packages forgot.
//
//   node scripts/packed-site.mjs [--keep]
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const manifestOf = (dir) => JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))
const published = (parent) =>
  readdirSync(join(ROOT, parent))
    .map((name) => `${parent}/${name}`)
    .filter((dir) => !manifestOf(dir).private)

// What npm gets: every package not marked private. A held-back plugin (private for now) is left
// out, and joins once it's published.
const PACKAGES = [...published('packages'), ...published('plugins')]
// The site starts with every published first-party plugin, by its short name.
const PLUGINS = published('plugins').map((dir) => dir.slice('plugins/'.length))

const keep = process.argv.includes('--keep')
const work = mkdtempSync(join(tmpdir(), 'otw-packed-site-'))
const run = (command, args, cwd, env = {}) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })

try {
  // Package name → its tarball, named as pnpm names them: @scope/name@1.0.0 → scope-name-1.0.0.tgz.
  const tarballs = join(work, 'tarballs')
  const byName = new Map()
  for (const dir of PACKAGES) {
    const { name, version } = manifestOf(dir)
    run('pnpm', ['pack', '--pack-destination', tarballs], join(ROOT, dir))
    byName.set(name, join(tarballs, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`))
  }

  // The scaffolder from its tarball, so a template file left out of the package is missed here too.
  const scaffolder = join(work, 'scaffolder')
  mkdirSync(scaffolder)
  run('tar', ['-xzf', byName.get('create-otw-cms'), '-C', scaffolder], work)
  const site = join(work, 'site')
  run(
    'node',
    [
      join(scaffolder, 'package/bin/create-otw-cms.js'),
      site,
      '--no-install',
      '--plugins',
      PLUGINS.join(','),
    ],
    work,
    { npm_config_user_agent: 'npm/11' },
  )

  // Every CMS package from its tarball: the site's own dependencies and those between packages.
  const manifestFile = join(site, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const local = (name) => `file:${byName.get(name)}`
  for (const field of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (byName.has(name)) manifest[field][name] = local(name)
    }
  }
  manifest.overrides = Object.fromEntries(
    [...byName.keys()]
      .filter((name) => name !== 'create-otw-cms')
      .map((name) => [name, local(name)]),
  )
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

  run('npm', ['install', '--no-audit', '--no-fund'], site)
  run('npm', ['run', 'typecheck'], site)
  run('npm', ['run', 'build'], site)
  console.log(`\nThe packed site type-checks and builds${keep ? `: ${site}` : '.'}`)
} finally {
  if (!keep) rmSync(work, { recursive: true, force: true })
}
