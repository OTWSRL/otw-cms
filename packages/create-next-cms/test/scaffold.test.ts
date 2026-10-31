import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectPackageManager,
  pluginPackage,
  scaffold,
  siteName,
  TEMPLATE,
} from '../src/scaffold.js'

describe('scaffold', () => {
  let parent: string
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'create-next-cms-'))
  })
  afterEach(() => rm(parent, { recursive: true, force: true }))

  const read = async (target: string, file: string) => readFile(join(target, file), 'utf8')

  it('writes a site that depends on this release of the CMS', async () => {
    const target = join(parent, 'My Shop')
    await scaffold({
      target,
      version: '0.3.1',
      plugins: ['commerce', '@acme/lms'],
      packageManager: 'pnpm',
    })

    const manifest = JSON.parse(await read(target, 'package.json'))
    expect(manifest.name).toBe('my-shop')
    expect(manifest.dependencies).toMatchObject({
      '@acme/lms': '^0.3.1',
      '@cms/admin-ui': '^0.3.1',
      '@cms/next': '^0.3.1',
      '@cms/plugin-commerce': '^0.3.1',
      '@cms/sdk': '^0.3.1',
      next: expect.stringMatching(/^\^16\./),
    })
    expect(manifest.devDependencies['@cms/cli']).toBe('^0.3.1')
    expect(manifest.scripts.build).toBe('cms generate && next build')
    expect(manifest.scripts['build:deploy']).toBe(
      'cms generate && cms migrate --no-backup && next build',
    )
    expect(JSON.parse(await read(target, 'cms.config.json'))).toEqual({
      plugins: ['@cms/plugin-commerce', '@acme/lms'],
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

  it('links a checkout of the CMS instead of the registry', async () => {
    const repo = resolve(import.meta.dirname, '../../..')
    const target = join(parent, 'linked')
    await scaffold({ target, version: '0.1.0', plugins: ['commerce'], link: repo })
    const { dependencies, devDependencies } = JSON.parse(await read(target, 'package.json'))
    expect(dependencies['@cms/next']).toMatch(/^link:.*\/packages\/next$/)
    expect(dependencies['@cms/plugin-commerce']).toMatch(/^link:.*\/plugins\/commerce$/)
    expect(devDependencies['@cms/cli']).toMatch(/^link:.*\/packages\/cli$/)
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
    expect(pluginPackage('commerce-stripe')).toBe('@cms/plugin-commerce-stripe')
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
})
