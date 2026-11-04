import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectPackageManager,
  latestVersion,
  pluginPackage,
  scaffold,
  siteName,
  TEMPLATE,
} from '../src/scaffold.js'

/** Plugins' newest versions on the registry, as `npm view` would give them, for the tests. */
const PUBLISHED: Record<string, string> = {
  '@acme/lms': '2.4.0',
  '@otwdesign/plugin-commerce': '1.7.2',
}
const resolveVersion = (pkg: string) => {
  const version = PUBLISHED[pkg]
  if (!version) throw new Error(`Can't find ${pkg} on npm: E404 Not Found`)
  return version
}

describe('scaffold', () => {
  let parent: string
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'create-otw-cms-'))
  })
  afterEach(() => rm(parent, { recursive: true, force: true }))

  const read = async (target: string, file: string) => readFile(join(target, file), 'utf8')

  it('writes a site that depends on this release of the CMS, and plugins on their own', async () => {
    const target = join(parent, 'My Shop')
    await scaffold({
      target,
      version: '0.3.1',
      plugins: ['commerce', '@acme/lms'],
      packageManager: 'pnpm',
      resolveVersion,
    })

    const manifest = JSON.parse(await read(target, 'package.json'))
    expect(manifest.name).toBe('my-shop')
    expect(manifest.dependencies).toMatchObject({
      // Plugins release apart from the CMS: each gets its own newest version, not the CMS's.
      '@acme/lms': '^2.4.0',
      '@otwdesign/plugin-commerce': '^1.7.2',
      '@otwdesign/admin-ui': '^0.3.1',
      '@otwdesign/next': '^0.3.1',
      '@otwdesign/sdk': '^0.3.1',
      next: expect.stringMatching(/^\^16\./),
    })
    expect(manifest.devDependencies['@otwdesign/cli']).toBe('^0.3.1')
    expect(manifest.scripts.build).toBe('cms generate && next build')
    expect(manifest.scripts['build:deploy']).toBe(
      'cms generate && cms migrate --no-backup && next build',
    )
    // Route types come from Next.js, and go stale when `cms generate` moves a route.
    expect(manifest.scripts.typecheck).toBe('cms generate && next typegen && tsc --noEmit')
    expect(JSON.parse(await read(target, 'cms.config.json'))).toEqual({
      plugins: ['@otwdesign/plugin-commerce', '@acme/lms'],
    })

    const files = await readdir(target, { recursive: true })
    expect(files).toEqual(
      expect.arrayContaining(['.gitignore', '.env.example', 'Dockerfile', 'next.config.ts']),
    )
    expect(files).not.toContain('gitignore')
    // The CMS's route files come from `cms generate` on the first dev or build.
    expect(files.some((file) => file.includes('(cms)'))).toBe(false)

    const readme = await read(target, 'README.md')
    expect(readme).toMatch(/^# my-shop$/m)
    expect(readme).toContain('pnpm cms update --check')
    expect(readme).not.toContain('{{')

    // The update workflow for git-based hosts, with this package manager's commands.
    const workflow = await read(target, '.github/workflows/cms-update.yml')
    expect(workflow).toContain("run: 'corepack enable && pnpm install --frozen-lockfile'")
    expect(workflow).toContain('pnpm cms update $PACKAGES $PLUGINS_ONLY --commit')
    expect(workflow.replace(/\$\{\{[^}]*\}\}/g, '')).not.toContain('{{')
    expect(await read(target, '.gitignore')).toContain('.cms/')
  })

  it('writes npm commands for npm', async () => {
    const target = join(parent, 'site')
    await scaffold({ target, version: '0.1.0', packageManager: 'npm' })
    const readme = await read(target, 'README.md')
    expect(readme).toContain('npx cms update --check')
    expect(readme).toContain('npm run build')
    const workflow = await read(target, '.github/workflows/cms-update.yml')
    expect(workflow).toContain("run: 'npm ci'")
    expect(workflow).toContain('npx cms update $PACKAGES $PLUGINS_ONLY --commit')
  })

  it.each([
    [
      'pnpm',
      'RUN corepack enable && pnpm install --frozen-lockfile && pnpm build',
      'RUN corepack enable',
      'CMD ["pnpm", "start"]',
    ],
    ['npm', 'RUN npm ci && npm run build', undefined, 'CMD ["npm", "start"]'],
    [
      'yarn',
      'RUN corepack enable && yarn install --immutable && yarn build',
      'RUN corepack enable',
      'CMD ["yarn", "start"]',
    ],
    [
      'bun',
      'RUN npm install --global bun && bun install --frozen-lockfile && bun run build',
      'RUN npm install --global bun',
      'CMD ["bun", "run", "start"]',
    ],
  ] as const)(
    'writes a Dockerfile that builds with %s',
    async (packageManager, build, runtime, start) => {
      const target = join(parent, `site-${packageManager}`)
      await scaffold({ target, version: '0.1.0', packageManager })
      const dockerfile = await read(target, 'Dockerfile')
      const [buildStage, runtimeStage] = dockerfile.split(/^FROM .* AS build$|^FROM /m).slice(1)
      expect(buildStage).toContain(build)
      if (runtime) expect(runtimeStage).toContain(runtime)
      else expect(runtimeStage).not.toContain('RUN ')
      expect(dockerfile).toContain(start)
      expect(dockerfile).not.toContain('{{')
      if (packageManager !== 'pnpm') expect(dockerfile).not.toContain('pnpm')
    },
  )

  it('links a checkout of the CMS instead of the registry', async () => {
    const repo = resolve(import.meta.dirname, '../../..')
    const target = join(parent, 'linked')
    await scaffold({ target, version: '0.1.0', plugins: ['mail-file'], link: repo })
    const { dependencies, devDependencies } = JSON.parse(await read(target, 'package.json'))
    expect(dependencies['@otwdesign/next']).toMatch(/^link:.*\/packages\/next$/)
    expect(dependencies['@otwdesign/plugin-mail-file']).toMatch(/^link:.*\/plugins\/mail-file$/)
    expect(devDependencies['@otwdesign/cli']).toMatch(/^link:.*\/packages\/cli$/)
  })

  it('stops before writing anything when a plugin isn’t on npm', async () => {
    const target = join(parent, 'site')
    await expect(
      scaffold({ target, version: '0.3.1', plugins: ['@acme/missing'], resolveVersion }),
    ).rejects.toThrow("Can't find @acme/missing on npm")
    await expect(readdir(target)).rejects.toThrow('ENOENT')
  })

  it('refuses a directory with files in it, and bad plugin names', async () => {
    const full = join(parent, 'full')
    await mkdir(full)
    await writeFile(join(full, 'index.html'), '')
    await expect(scaffold({ target: full, version: '0.1.0' })).rejects.toThrow('is not empty')
    await expect(
      scaffold({ target: join(parent, 'x'), version: '0.1.0', plugins: ['Bad Name'] }),
    ).rejects.toThrow('Invalid plugin package name')
  })
})

describe('helpers', () => {
  it('names first-party plugins by their short name', () => {
    expect(pluginPackage('commerce-stripe')).toBe('@otwdesign/plugin-commerce-stripe')
    expect(pluginPackage('@acme/lms')).toBe('@acme/lms')
  })

  it('makes a package name from the directory', () => {
    expect(siteName('/sites/Ada’s Shop')).toBe('ada-s-shop')
    expect(() => siteName('/sites/---')).toThrow("Can't make a package name")
  })

  it('uses the package manager that ran it', () => {
    expect(detectPackageManager('pnpm/10.5.2 npm/? node/v26.5.0 darwin arm64')).toBe('pnpm')
    expect(detectPackageManager('yarn/4.9.0 npm/? node/v26.5.0')).toBe('yarn')
    expect(detectPackageManager('')).toBe('npm')
  })
})

/** apps/web is the CMS's own site; it must stay what a new site is, so its tests prove the template. */
describe('the template', () => {
  const web = resolve(import.meta.dirname, '../../../apps/web')
  it.each(['src/app/(site)/layout.tsx', 'src/app/globals.css', 'next.config.ts'])(
    'matches apps/web’s %s',
    async (file) => {
      expect(await readFile(join(TEMPLATE, file), 'utf8')).toBe(
        await readFile(join(web, file), 'utf8'),
      )
    },
  )

  it('has every compiler option Next.js adds on a first build, so building doesn’t rewrite it', async () => {
    const { compilerOptions } = JSON.parse(await readFile(join(TEMPLATE, 'tsconfig.json'), 'utf8'))
    // Next's suggested values (verify-typescript-setup); a missing one rewrites the whole file.
    expect(compilerOptions).toMatchObject({
      allowJs: true,
      esModuleInterop: true,
      incremental: true,
      isolatedModules: true,
      jsx: 'react-jsx',
      module: 'esnext',
      moduleResolution: 'bundler',
      noEmit: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: true,
    })
  })
})

describe('latestVersion', () => {
  it('reads the version npm view prints', () => {
    const calls: unknown[][] = []
    const run = (command: string, args: string[], options: { cwd: string }) => {
      calls.push([command, args, options.cwd])
      return '1.0.7\n'
    }
    expect(latestVersion('@otwdesign/plugin-performance', { cwd: '/sites', run })).toBe('1.0.7')
    expect(calls).toEqual([['npm', ['view', '@otwdesign/plugin-performance', 'version'], '/sites']])
  })

  it('says which plugin npm couldn’t find, and why', () => {
    const run = () => {
      throw Object.assign(new Error('Command failed'), {
        stderr:
          'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fnope\n',
      })
    }
    expect(() => latestVersion('@acme/nope', { run })).toThrow(
      "Can't find @acme/nope on npm: npm error code E404",
    )
  })

  it('refuses output that isn’t a version', () => {
    expect(() => latestVersion('@acme/odd', { run: () => 'nope\n' })).toThrow(
      'npm view @acme/odd version printed "nope", not a version',
    )
  })
})
