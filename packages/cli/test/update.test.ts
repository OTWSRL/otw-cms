import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  nextSpec,
  npmView,
  planUpdate,
  resolveTargets,
  writeChanges,
  type Packument,
  type SitePackages,
} from '../src/update.ts'

type Peers = Record<string, string>

/** Versions with their peer dependencies; a string is shorthand for a range on @cms/sdk. */
function packument(name: string, versions: Record<string, string | Peers | null>): Packument {
  return {
    name,
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, peers]) => [
        version,
        {
          version,
          ...(peers
            ? { peerDependencies: typeof peers === 'string' ? { '@cms/sdk': peers } : peers }
            : {}),
        },
      ]),
    ),
  }
}

const core = (...versions: string[]) =>
  Object.fromEntries(
    ['@cms/next', '@cms/cli'].map((name) => [
      name,
      packument(name, Object.fromEntries(versions.map((v) => [v, null]))),
    ]),
  )

const COMMERCE = '@cms/plugin-commerce'
const STRIPE = '@cms/plugin-commerce-stripe'

/** Core 0.1.0 with Commerce and Stripe, which needs Commerce. */
const site = (extra: Partial<SitePackages> = {}): SitePackages => ({
  specs: {
    '@cms/next': '^0.1.0',
    '@cms/cli': '^0.1.0',
    [COMMERCE]: '^0.1.0',
    [STRIPE]: '^0.1.0',
  },
  installed: { '@cms/next': '0.1.0', '@cms/cli': '0.1.0', [COMMERCE]: '0.1.0', [STRIPE]: '0.1.0' },
  peers: {
    [COMMERCE]: { '@cms/sdk': '^0.1.0' },
    [STRIPE]: { '@cms/sdk': '^0.1.0', [COMMERCE]: '^0.1.0' },
  },
  plugins: [COMMERCE, STRIPE],
  ...extra,
})

const stripe = (versions: Record<string, Peers>) => packument(STRIPE, versions)
const withCommerce = (range: string): Peers => ({ '@cms/sdk': '^0.1.0', [COMMERCE]: range })

describe('planUpdate', () => {
  it('moves core within its caret range and each plugin to its newest that supports it', () => {
    const plan = planUpdate(site(), {
      ...core('0.1.0', '0.1.4', '0.2.0', '0.3.0-beta.1'),
      [COMMERCE]: packument(COMMERCE, { '0.1.0': '^0.1.0', '0.1.2': '^0.1.0', '0.2.0': '^0.2.0' }),
      [STRIPE]: stripe({ '0.1.0': withCommerce('^0.1.0'), '0.1.1': withCommerce('^0.1.0') }),
    })
    expect(plan.core).toEqual({ from: '0.1.0', to: '0.1.4' })
    expect(plan.plugins).toEqual([
      {
        name: COMMERCE,
        from: '0.1.0',
        to: '0.1.2',
        latest: '0.2.0',
        compatible: 'yes',
        note: '0.2.0 needs a different core than 0.1.4',
      },
      { name: STRIPE, from: '0.1.0', to: '0.1.1', latest: '0.1.1', compatible: 'yes' },
    ])
    expect(plan.changes.map(({ name, to }) => `${name}@${to}`)).toEqual([
      '@cms/next@0.1.4',
      '@cms/cli@0.1.4',
      `${COMMERCE}@0.1.2`,
      `${STRIPE}@0.1.1`,
    ])
    expect(plan.blockers).toEqual([])
  })

  it('holds a plugin back when another plugin needs its older version', () => {
    const plan = planUpdate(site(), {
      ...core('0.1.0'),
      // Commerce 1.0 supports this core, but no Stripe works with it yet.
      [COMMERCE]: packument(COMMERCE, { '0.1.0': '^0.1.0', '0.1.5': '^0.1.0', '1.0.0': '^0.1.0' }),
      [STRIPE]: stripe({ '0.1.0': withCommerce('^0.1.0'), '0.1.2': withCommerce('^0.1.0') }),
    })
    expect(plan.plugins[0]).toEqual({
      name: COMMERCE,
      from: '0.1.0',
      to: '0.1.5',
      latest: '1.0.0',
      compatible: 'yes',
      note: `${STRIPE} 0.1.2 needs ${COMMERCE} ^0.1.0`,
    })
    expect(plan.plugins[1]).toMatchObject({ to: '0.1.2' })
  })

  it('moves both when a newer version of the plugin that needs it follows along', () => {
    const plan = planUpdate(site(), {
      ...core('0.1.0'),
      [COMMERCE]: packument(COMMERCE, { '0.1.0': '^0.1.0', '1.0.0': '^0.1.0' }),
      [STRIPE]: stripe({ '0.1.0': withCommerce('^0.1.0'), '0.2.0': withCommerce('^1.0.0') }),
    })
    expect(plan.changes.map(({ name, to }) => `${name}@${to}`)).toEqual([
      `${COMMERCE}@1.0.0`,
      `${STRIPE}@0.2.0`,
    ])
  })

  it('holds back the plugin that needs a newer one when that one isn’t being updated', () => {
    const plan = planUpdate(
      site(),
      {
        // Only Stripe is looked up; Commerce stays at 0.1.0.
        [STRIPE]: stripe({
          '0.1.0': withCommerce('^0.1.0'),
          '0.1.3': withCommerce('^0.1.0'),
          '0.2.0': withCommerce('^1.0.0'),
        }),
      },
      { only: [STRIPE] },
    )
    expect(plan.core).toBeNull()
    expect(plan.plugins).toEqual([
      {
        name: STRIPE,
        from: '0.1.0',
        to: '0.1.3',
        latest: '0.2.0',
        compatible: 'yes',
        note: `0.2.0 needs ${COMMERCE} ^1.0.0, and ${COMMERCE} stays at 0.1.0`,
      },
    ])
  })

  it('leaves core alone with --plugins-only', () => {
    const plan = planUpdate(
      site(),
      {
        [COMMERCE]: packument(COMMERCE, { '0.1.0': '^0.1.0', '0.1.1': '^0.1.0' }),
        [STRIPE]: stripe({ '0.1.0': withCommerce('^0.1.0') }),
      },
      { pluginsOnly: true },
    )
    expect(plan.core).toBeNull()
    expect(plan.changes).toEqual([{ name: COMMERCE, from: '0.1.0', to: '0.1.1' }])
  })

  it('carries on without a plugin npm can’t reach, and says so', () => {
    const plan = planUpdate(site(), {
      ...core('0.1.0', '0.1.1'),
      [COMMERCE]: { name: COMMERCE, error: '403 Forbidden - GET https://npm.acme.test/...' },
      [STRIPE]: stripe({ '0.1.0': withCommerce('^0.1.0'), '0.1.1': withCommerce('^0.1.0') }),
    })
    expect(plan.core).toEqual({ from: '0.1.0', to: '0.1.1' })
    expect(plan.plugins[0]).toEqual({
      name: COMMERCE,
      from: '0.1.0',
      to: null,
      latest: null,
      compatible: 'yes',
    })
    expect(plan.warnings).toEqual([
      `Couldn't check ${COMMERCE}: 403 Forbidden - GET https://npm.acme.test/.... It stays at 0.1.0.`,
    ])
    expect(plan.blockers).toEqual([])
  })

  it('crosses to a new core major only when asked, blocking a plugin left behind', () => {
    const packuments = {
      ...core('0.1.0', '0.2.0'),
      [COMMERCE]: packument(COMMERCE, { '0.1.0': '^0.1.0' }),
      [STRIPE]: stripe({ '0.1.0': withCommerce('^0.1.0') }),
    }
    expect(planUpdate(site(), packuments).core).toBeNull()
    const plan = planUpdate(site(), packuments, { major: true })
    expect(plan.core).toEqual({ from: '0.1.0', to: '0.2.0' })
    expect(plan.blockers).toEqual([
      `${COMMERCE} 0.1.0 doesn't support core 0.2.0, and no newer version does yet; it would be switched off.`,
      `${STRIPE} 0.1.0 doesn't support core 0.2.0, and no newer version does yet; it would be switched off.`,
    ])
  })

  it('blocks a core update that would strand a plugin left out of the update', () => {
    const plan = planUpdate(site(), core('0.1.0', '0.2.0'), { only: ['@cms/next'], major: true })
    expect(plan.plugins).toEqual([])
    expect(plan.blockers).toEqual([
      `${COMMERCE} 0.1.0 doesn't support core 0.2.0; update it too, or it would be switched off.`,
      `${STRIPE} 0.1.0 doesn't support core 0.2.0; update it too, or it would be switched off.`,
    ])
  })

  it('keeps plugins that say nothing about core within their caret range, flagged unknown', () => {
    const plan = planUpdate(
      site({ peers: {} }),
      {
        [COMMERCE]: packument(COMMERCE, { '0.1.0': null, '0.1.3': null, '0.2.0': null }),
        [STRIPE]: stripe({}),
      },
      { pluginsOnly: true },
    )
    expect(plan.plugins[0]).toEqual({
      name: COMMERCE,
      from: '0.1.0',
      to: '0.1.3',
      latest: '0.2.0',
      compatible: 'unknown',
      note: "0.2.0 is a new major version that doesn't say which core it supports",
    })
  })

  it('refuses to split core packages across versions', () => {
    const plan = planUpdate(site(), {
      '@cms/next': packument('@cms/next', { '0.1.0': null, '0.1.1': null }),
      '@cms/cli': packument('@cms/cli', { '0.1.0': null }),
      [COMMERCE]: packument(COMMERCE, { '0.1.0': '^0.1.0' }),
      [STRIPE]: stripe({ '0.1.0': withCommerce('^0.1.0') }),
    })
    expect(plan.blockers).toEqual([
      '@cms/cli 0.1.1 is not published, and core packages update together.',
    ])
  })

  it('leaves workspace and file links to the workspace', () => {
    const plan = planUpdate(
      site({
        specs: {
          '@cms/next': 'workspace:*',
          '@cms/cli': 'workspace:*',
          [COMMERCE]: 'file:../commerce',
          [STRIPE]: 'link:../stripe',
        },
      }),
      {},
    )
    expect(plan).toMatchObject({ core: null, changes: [], plugins: [], blockers: [] })
    expect(plan.linked).toEqual(['@cms/next', '@cms/cli', COMMERCE, STRIPE])
  })

  it('says to install first when a package is missing from node_modules', () => {
    expect(() => planUpdate(site({ installed: {} }), core('0.1.0'))).toThrow(
      '@cms/next is not installed',
    )
  })
})

describe('resolveTargets', () => {
  it('takes package names, first-party short names, and "core"', () => {
    expect(resolveTargets(site(), ['commerce-stripe', COMMERCE, 'core', '@cms/cli'])).toEqual([
      STRIPE,
      COMMERCE,
      '@cms/next',
      '@cms/cli',
    ])
  })

  it('finds a third-party plugin by its name without the scope, unless that’s ambiguous', () => {
    const plugins = [COMMERCE, '@acme/forum', '@acme/lms', '@other/lms']
    expect(resolveTargets(site({ plugins }), ['forum'])).toEqual(['@acme/forum'])
    expect(() => resolveTargets(site({ plugins }), ['lms'])).toThrow(
      'lms could be @acme/lms or @other/lms; use the full package name.',
    )
  })

  it('names the installed plugins when it doesn’t know one', () => {
    expect(() => resolveTargets(site(), ['forum'])).toThrow(
      `forum is not an installed plugin or a CMS package. Installed plugins: ${COMMERCE}, ${STRIPE}.`,
    )
  })
})

describe('npmView', () => {
  const calls: { args: string[]; cwd: string }[] = []
  const answering =
    (stdout: string) =>
    async (_file: string, args: string[], { cwd }: { cwd: string }) => {
      calls.push({ args, cwd })
      return { stdout }
    }
  beforeEach(() => {
    calls.length = 0
  })

  it('asks npm from the site, so .npmrc registries and tokens apply', async () => {
    const view = npmView(
      '/sites/shop',
      answering(
        JSON.stringify([
          { version: '0.1.0', peerDependencies: { '@cms/sdk': '^0.1.0' } },
          { version: '0.1.1' },
        ]),
      ),
    )
    expect(await view('@acme/lms', '0.1.0')).toEqual({
      name: '@acme/lms',
      versions: {
        '0.1.0': { version: '0.1.0', peerDependencies: { '@cms/sdk': '^0.1.0' } },
        '0.1.1': { version: '0.1.1' },
      },
    })
    expect(calls).toEqual([
      {
        args: ['view', '@acme/lms@>=0.0.0', 'version', 'peerDependencies', '--json'],
        cwd: '/sites/shop',
      },
    ])
  })

  it('reads a single version, none, and later prereleases of a prerelease', async () => {
    expect(await npmView('/s', answering('{"version":"1.0.0"}'))('x', '1.0.0')).toEqual({
      name: 'x',
      versions: { '1.0.0': { version: '1.0.0' } },
    })
    expect(await npmView('/s', answering(''))('x', '1.0.0')).toEqual({ name: 'x', versions: {} })
    // Versions without peer dependencies come back as bare strings.
    expect(await npmView('/s', answering('["1.0.0","1.1.0"]'))('x', '1.0.0')).toEqual({
      name: 'x',
      versions: { '1.0.0': { version: '1.0.0' }, '1.1.0': { version: '1.1.0' } },
    })
    expect(await npmView('/s', answering('"1.1.0"'))('x', '1.0.0')).toEqual({
      name: 'x',
      versions: { '1.1.0': { version: '1.1.0' } },
    })
    await npmView('/s', answering(''))('x', '2.0.0-beta.1')
    expect(calls.at(-1)!.args[1]).toBe('x@>=2.0.0-beta.1')
  })

  it('reports npm’s own reason when the lookup fails', async () => {
    const failing = async () => {
      throw Object.assign(new Error('Command failed: npm view'), {
        stdout: JSON.stringify({ error: { code: 'E404', summary: 'Not Found - GET .../x' } }),
      })
    }
    await expect(npmView('/s', failing)('x', '1.0.0')).rejects.toThrow('Not Found - GET .../x')
    const offline = async () => {
      throw new Error('spawn npm ENOENT')
    }
    await expect(npmView('/s', offline)('x', '1.0.0')).rejects.toThrow('spawn npm ENOENT')
  })
})

describe('writeChanges', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cms-update-'))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('rewrites only the versions, keeping each spec’s style and the rest of the file', async () => {
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify(
        {
          name: 'site',
          scripts: { build: 'cms generate && next build' },
          dependencies: { '@cms/next': '^0.1.0', '@acme/lms': '1.0.0', next: '^16.4.0' },
          devDependencies: { '@cms/cli': '~0.1.0' },
        },
        null,
        4,
      )}\n`,
    )
    await writeChanges(root, [
      { name: '@cms/next', from: '0.1.0', to: '0.1.4' },
      { name: '@cms/cli', from: '0.1.0', to: '0.1.4' },
      { name: '@acme/lms', from: '1.0.0', to: '1.1.0' },
    ])
    const written = await readFile(join(root, 'package.json'), 'utf8')
    expect(JSON.parse(written)).toEqual({
      name: 'site',
      scripts: { build: 'cms generate && next build' },
      dependencies: { '@cms/next': '^0.1.4', '@acme/lms': '1.1.0', next: '^16.4.0' },
      devDependencies: { '@cms/cli': '~0.1.4' },
    })
    expect(written).toMatch(/^ {4}"name"/m)
  })

  it.each([
    ['^0.1.0', '0.2.0', '^0.2.0'],
    ['~1.2.0', '1.2.5', '~1.2.5'],
    ['1.0.0', '1.1.0', '1.1.0'],
  ])('turns %s into %s → %s', (current, version, expected) => {
    expect(nextSpec(current, version)).toBe(expected)
  })
})
