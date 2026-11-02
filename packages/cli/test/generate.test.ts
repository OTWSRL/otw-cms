import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generate, MARKER, managedFiles, parseConfig } from '../src/generate.ts'

describe('parseConfig', () => {
  it('accepts scoped and unscoped package names', () => {
    expect(parseConfig({ plugins: ['@otw/plugin-commerce', 'cms-plugin-lms'] })).toEqual({
      plugins: ['@otw/plugin-commerce', 'cms-plugin-lms'],
    })
  })

  it.each([
    [{}, 'must contain a "plugins" array'],
    [null, 'must contain a "plugins" array'],
    [{ plugins: 'commerce' }, 'must contain a "plugins" array'],
    [{ plugins: [42] }, 'Invalid plugin package name: 42'],
    [{ plugins: ['Upper'] }, 'Invalid plugin package name'],
    [{ plugins: ["x'; process.exit(1); '"] }, 'Invalid plugin package name'],
    [{ plugins: ['../../etc'] }, 'Invalid plugin package name'],
    [{ plugins: ['a', 'a'] }, 'listed twice'],
  ])('rejects %j', (raw, message) => {
    expect(() => parseConfig(raw)).toThrow(message)
  })

  it('takes a brand, for selling the CMS under another name', () => {
    const brand = { name: 'Acme Sites', url: 'https://acme.example', logo: '/brand/logo.svg' }
    expect(parseConfig({ plugins: [], brand: { ...brand, name: '  Acme Sites ' } })).toEqual({
      plugins: [],
      brand,
    })
    const hosted = { name: 'Acme', logo: 'https://cdn.acme.example/logo.png' }
    expect(parseConfig({ plugins: [], brand: hosted }).brand).toEqual(hosted)
  })

  it.each([
    ['Acme', '"brand" must be an object'],
    [null, '"brand" must be an object'],
    [['Acme'], '"brand" must be an object'],
    [{}, '"brand.name" must be text of 1 to 60 characters'],
    [{ name: '   ' }, '"brand.name"'],
    [{ name: 'x'.repeat(61) }, '"brand.name"'],
    [{ name: 'Acme\nSites' }, '"brand.name"'],
    [{ name: 'Acme', link: 'https://acme.example' }, '"brand" has no field "link"'],
    [{ name: 'Acme', url: 'javascript:alert(1)' }, '"brand.url" must be an http or https URL'],
    [{ name: 'Acme', url: 'acme.example' }, '"brand.url"'],
    [{ name: 'Acme', logo: 'http://acme.example/logo.png' }, '"brand.logo" must be a path'],
    [{ name: 'Acme', logo: '//elsewhere.example/logo.png' }, '"brand.logo"'],
    [{ name: 'Acme', logo: '/\\elsewhere.example/logo.png' }, '"brand.logo"'],
    [{ name: 'Acme', logo: 'data:image/svg+xml,<svg onload=alert(1)>' }, '"brand.logo"'],
    [{ name: 'Acme', logo: 'logo.svg' }, '"brand.logo"'],
  ])('rejects the brand %j', (brand, message) => {
    expect(() => parseConfig({ plugins: [], brand })).toThrow(message)
  })
})

describe('parseConfig routes', () => {
  it('takes new paths for plugin pages, by qualified name', () => {
    const routes = { 'commerce.product': '/p/:slug', 'lms.course': '/learn/:slug' }
    expect(parseConfig({ plugins: [], routes })).toEqual({ plugins: [], routes })
  })

  it.each([
    ['/p/:slug', '"routes" must be an object'],
    [null, '"routes" must be an object'],
    [{ product: '/p/:slug' }, 'routes: "product" must name a plugin\'s page'],
    [{ 'Commerce.product': '/p' }, "must name a plugin's page"],
    [{ 'commerce.product': 'p/:slug' }, '"commerce.product" must be a path such as /shop/:slug'],
    [{ 'commerce.product': 42 }, 'must be a path'],
    [{ 'commerce.product': '/p/<script>' }, 'must be a path'],
    [{ 'commerce.product': `/${'a'.repeat(200)}` }, 'must be a path'],
  ])('rejects the routes %j', (routes, message) => {
    expect(() => parseConfig({ plugins: [], routes })).toThrow(message)
  })
})

describe('managedFiles', () => {
  const config = { plugins: ['@otw/plugin-commerce', '@otw/plugin-commerce-stripe'] }

  it('registers the installed plugins in config order', () => {
    const [site] = managedFiles(config, { srcDir: 'src' })
    expect(site).toEqual({
      path: 'src/cms/site.generated.ts',
      content: `${MARKER}
import { defineSite } from '@otw/next'
import plugin0 from "@otw/plugin-commerce"
import plugin1 from "@otw/plugin-commerce-stripe"

export const site = defineSite({
  plugins: [plugin0, plugin1],
  packages: ["@otw/plugin-commerce", "@otw/plugin-commerce-stripe"],
})
`,
    })
    expect(managedFiles({ plugins: [] }, { srcDir: 'src' })[0]!.content).toContain(
      '  plugins: [],\n  packages: [],',
    )
  })

  it('gives the site its route overrides, when it has any', () => {
    const [site] = managedFiles(
      { plugins: [], routes: { 'commerce.product': '/p/:slug' } },
      { srcDir: 'src' },
    )
    expect(site!.content).toContain(
      '  packages: [],\n  routes: {"commerce.product":"/p/:slug"},\n})',
    )
  })

  it('gives the site its brand, when it has one', () => {
    const brand = { name: 'Acme "Sites"', url: 'https://acme.example' }
    const [site] = managedFiles({ plugins: [], brand }, { srcDir: 'src' })
    expect(site!.content).toContain(
      '  packages: [],\n  brand: {"name":"Acme \\"Sites\\"","url":"https://acme.example"},\n})',
    )
  })

  it("gives the admin the plugins' admin entries, in a site module of its own", () => {
    const [, admin] = managedFiles(config, { srcDir: 'src' }, ['@otw/plugin-commerce-stripe'])
    expect(admin).toEqual({
      path: 'src/cms/admin.generated.ts',
      content: `${MARKER}
// The admin's site module: the plugins and their admin entries. Only the admin and the API import it.
import { defineSite } from '@otw/next'
import plugin0 from "@otw/plugin-commerce"
import plugin1 from "@otw/plugin-commerce-stripe"
import admin1 from "@otw/plugin-commerce-stripe/admin"

export const site = defineSite({
  plugins: [plugin0, plugin1],
  admin: [admin1],
  packages: ["@otw/plugin-commerce", "@otw/plugin-commerce-stripe"],
})
`,
    })
    expect(managedFiles(config, { srcDir: 'src' })[1]!.content).toContain('  admin: [],')
  })

  it("mounts the admin and the API on the admin's site module, the storefront on the site's", () => {
    const files = managedFiles(config, { srcDir: 'src' })
    expect(files.map((managed) => managed.path)).toEqual([
      'src/cms/site.generated.ts',
      'src/cms/admin.generated.ts',
      'src/app/(cms)/layout.tsx',
      'src/app/(cms)/admin/[[...segments]]/page.tsx',
      'src/app/(cms)/admin/forbidden.tsx',
      'src/app/(cms)/admin/not-found.tsx',
      'src/app/(cms)/api/p/[...path]/route.ts',
      'src/instrumentation.ts',
      'src/app/(site)/page.tsx',
      'src/app/(site)/[...slug]/page.tsx',
    ])
    const admin = files.find((managed) => managed.path.endsWith('[[...segments]]/page.tsx'))!
    expect(admin.content).toBe(`${MARKER}
import '../../../../cms/admin.generated'
export { AdminPage as default, generateAdminMetadata as generateMetadata } from '@otw/next/admin'
export const dynamic = 'force-dynamic'
`)
    const imports = (path: string) => files.find((managed) => managed.path === path)!.content
    expect(imports('src/app/(cms)/layout.tsx')).toContain("import '../../cms/admin.generated'")
    expect(imports('src/app/(cms)/api/p/[...path]/route.ts')).toContain(
      "import '../../../../../cms/admin.generated'",
    )
    expect(imports('src/app/(site)/page.tsx')).toContain("import '../../cms/site.generated'")
    expect(imports('src/app/(site)/[...slug]/page.tsx')).toContain(
      "import '../../../cms/site.generated'",
    )
    for (const managed of files) expect(managed.content.startsWith(`${MARKER}\n`)).toBe(true)
  })

  it('works without a src directory', () => {
    const files = managedFiles(config, { srcDir: '' })
    expect(files[0]!.path).toBe('cms/site.generated.ts')
    expect(files[1]!.path).toBe('cms/admin.generated.ts')
    expect(files[2]).toMatchObject({ path: 'app/(cms)/layout.tsx' })
    expect(files[2]!.content).toContain("import '../../cms/admin.generated'")
  })
})

describe('generate', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cms-cli-'))
    await mkdir(join(root, 'src', 'app'), { recursive: true })
    await writeFile(join(root, 'cms.config.json'), JSON.stringify({ plugins: ['@acme/lms'] }))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const statuses = async () =>
    Object.fromEntries((await generate({ root })).files.map((f) => [f.path, f.status]))

  it('writes every file, then leaves them alone until something changes', async () => {
    expect(Object.values(await statuses())).toEqual(Array(10).fill('written'))
    const site = join(root, 'src/cms/site.generated.ts')
    expect(await readFile(site, 'utf8')).toContain('import plugin0 from "@acme/lms"')
    const written = (await stat(site)).mtimeMs

    expect(Object.values(await statuses())).toEqual(Array(10).fill('unchanged'))
    expect((await stat(site)).mtimeMs).toBe(written)

    await writeFile(join(root, 'cms.config.json'), JSON.stringify({ plugins: [] }))
    expect((await statuses())['src/cms/site.generated.ts']).toBe('written')
  })

  /** Installs a package with these exports in `node_modules` under `dir`. */
  async function install(dir: string, name: string, exports: unknown) {
    const at = join(dir, 'node_modules', ...name.split('/'))
    await mkdir(at, { recursive: true })
    await writeFile(join(at, 'package.json'), JSON.stringify({ name, exports }))
  }

  it("finds each plugin's admin entry in its package's exports", async () => {
    const plugins = ['@acme/lms', '@acme/quiz', '@acme/not-installed']
    await writeFile(join(root, 'cms.config.json'), JSON.stringify({ plugins }))
    await install(root, '@acme/lms', { '.': './src/index.ts', './admin': './src/admin.tsx' })
    await install(root, '@acme/quiz', { '.': './src/index.ts' })
    await generate({ root })
    const admin = await readFile(join(root, 'src/cms/admin.generated.ts'), 'utf8')
    expect(admin).toContain('import admin0 from "@acme/lms/admin"')
    expect(admin).toContain('  admin: [admin0],')
    expect(admin).not.toContain('@acme/quiz/admin')
  })

  it('finds packages a workspace installs in a parent folder', async () => {
    const site = join(root, 'apps', 'web')
    await mkdir(join(site, 'src', 'app'), { recursive: true })
    await writeFile(join(site, 'cms.config.json'), JSON.stringify({ plugins: ['@acme/lms'] }))
    await install(root, '@acme/lms', { '.': './src/index.ts', './admin': './src/admin.tsx' })
    await generate({ root: site })
    expect(await readFile(join(site, 'src/cms/admin.generated.ts'), 'utf8')).toContain(
      '  admin: [admin0],',
    )
  })

  it('overwrites edits to a managed file, but keeps a file without the marker', async () => {
    await generate({ root })
    const layout = join(root, 'src/app/(cms)/layout.tsx')
    const page = join(root, 'src/app/(site)/[...slug]/page.tsx')
    await writeFile(layout, `${MARKER}\nexport default function Broken() {}\n`)
    await writeFile(page, 'export default function Home() { return "mine" }\n')

    const result = await statuses()
    expect(result['src/app/(cms)/layout.tsx']).toBe('written')
    expect(await readFile(layout, 'utf8')).toContain('AdminRootLayout as default')
    expect(result['src/app/(site)/[...slug]/page.tsx']).toBe('kept')
    expect(await readFile(page, 'utf8')).toContain('"mine"')
  })

  it('loads the CMS’s instrumentation, unless the site has its own', async () => {
    const [instrumentation] = managedFiles({ plugins: [] }, { srcDir: 'src' }).filter((managed) =>
      managed.path.endsWith('instrumentation.ts'),
    )
    expect(instrumentation).toEqual({
      path: 'src/instrumentation.ts',
      content: `${MARKER}\nexport { register } from '@otw/next/instrumentation'\n`,
      replaceable: true,
    })
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/instrumentation.ts'), 'export function register() {}\n')
    expect((await statuses())['src/instrumentation.ts']).toBe('own')
  })

  it('lets the site have its own home page, as it has its other pages', async () => {
    const home = join(root, 'src/app/(site)/page.tsx')
    await mkdir(join(root, 'src/app/(site)'), { recursive: true })
    await writeFile(home, 'export default function Home() { return "hello" }\n')

    const result = await statuses()
    // Not 'kept': that warns the site to compare its copy after updates.
    expect(result['src/app/(site)/page.tsx']).toBe('own')
    expect(result['src/app/(site)/[...slug]/page.tsx']).toBe('written')
    expect(await readFile(home, 'utf8')).toContain('"hello"')
  })

  it('removes the optional catch-all earlier versions wrote, which claimed the home page too', async () => {
    const old = join(root, 'src/app/(site)/[[...slug]]/page.tsx')
    await mkdir(join(old, '..'), { recursive: true })
    await writeFile(old, `${MARKER}\nexport { SitePage as default } from '@otw/next/site'\n`)

    const result = await statuses()
    expect(result['src/app/(site)/[[...slug]]/page.tsx']).toBe('removed')
    await expect(stat(join(old, '..'))).rejects.toThrow('ENOENT')
    expect(result['src/app/(site)/page.tsx']).toBe('written')
    expect(result['src/app/(site)/[...slug]/page.tsx']).toBe('written')
  })

  it('keeps an old catch-all the site made its own, and doesn’t write routes that clash with it', async () => {
    const old = join(root, 'src/app/(site)/[[...slug]]/page.tsx')
    await mkdir(join(old, '..'), { recursive: true })
    await writeFile(old, 'export default function Mine() { return "mine" }\n')

    const result = await statuses()
    expect(result['src/app/(site)/[[...slug]]/page.tsx']).toBe('kept')
    expect(result).not.toHaveProperty(['src/app/(site)/page.tsx'])
    await expect(stat(join(root, 'src/app/(site)/page.tsx'))).rejects.toThrow('ENOENT')
    await expect(stat(join(root, 'src/app/(site)/[...slug]'))).rejects.toThrow('ENOENT')
    expect(await readFile(old, 'utf8')).toContain('"mine"')
  })

  it('fails on invalid JSON without writing anything', async () => {
    await writeFile(join(root, 'cms.config.json'), '{ plugins: ')
    await expect(generate({ root })).rejects.toThrow(SyntaxError)
    await expect(stat(join(root, 'src/cms'))).rejects.toThrow('ENOENT')
  })
})
