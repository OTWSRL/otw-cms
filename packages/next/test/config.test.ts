import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CORE_PACKAGES, withCms } from '../config.js'

describe('withCms', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cms-config-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const write = (config: unknown) => writeFile(join(dir, 'cms.config.json'), JSON.stringify(config))

  it('compiles the CMS and installed plugins, and keeps the site’s own settings', async () => {
    await write({ plugins: ['@acme/cms-lms'] })
    const config = withCms(
      {
        transpilePackages: ['@acme/ui', '@otwdesign/core'],
        serverExternalPackages: ['sharp'],
        experimental: { typedRoutes: true },
        poweredByHeader: false,
      },
      { config: join(dir, 'cms.config.json') },
    )
    expect(config.transpilePackages).toEqual([
      '@acme/ui',
      '@otwdesign/core',
      ...CORE_PACKAGES.filter((name) => name !== '@otwdesign/core'),
      '@acme/cms-lms',
    ])
    expect(config.serverExternalPackages).toEqual(['sharp', '@electric-sql/pglite'])
    expect(config.experimental).toEqual({ typedRoutes: true, authInterrupts: true })
    expect(config.poweredByHeader).toBe(false)
  })

  it('explains a broken plugin list', async () => {
    await write({ plugins: '@acme/cms-lms' })
    expect(() => withCms({}, { config: join(dir, 'cms.config.json') })).toThrow(
      '"plugins" must be a list of package names',
    )
  })
})
