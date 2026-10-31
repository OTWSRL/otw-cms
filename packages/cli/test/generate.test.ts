import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generate, MARKER, managedFiles, parseConfig } from '../src/generate.ts'

describe('parseConfig', () => {
  it('accepts scoped and unscoped package names', () => {
    expect(parseConfig({ plugins: ['@cms/plugin-commerce', 'cms-plugin-lms'] })).toEqual({
      plugins: ['@cms/plugin-commerce', 'cms-plugin-lms'],
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
})

describe('managedFiles', () => {
  const config = { plugins: ['@cms/plugin-commerce', '@cms/plugin-commerce-stripe'] }

  it('registers the installed plugins in config order', () => {
    const [site] = managedFiles(config, { srcDir: 'src' })
    expect(site).toEqual({
      path: 'src/cms/site.generated.ts',
      content: `${MARKER}
import { defineSite } from '@cms/next'
import plugin0 from "@cms/plugin-commerce"
import plugin1 from "@cms/plugin-commerce-stripe"

export const site = defineSite({ plugins: [plugin0, plugin1] })
`,
    })
    expect(managedFiles({ plugins: [] }, { srcDir: 'src' })[0]!.content).toContain(
      'defineSite({ plugins: [] })',
    )
  })

  it('mounts the admin, the API and the storefront, each importing the site', () => {
    const files = managedFiles(config, { srcDir: 'src' })
    expect(files.map((managed) => managed.path)).toEqual([
      'src/cms/site.generated.ts',
      'src/app/(cms)/layout.tsx',
      'src/app/(cms)/admin/[[...segments]]/page.tsx',
      'src/app/(cms)/admin/forbidden.tsx',
      'src/app/(cms)/admin/not-found.tsx',
      'src/app/(cms)/api/p/[...path]/route.ts',
      'src/app/(site)/[[...slug]]/page.tsx',
    ])
    const admin = files.find((managed) => managed.path.endsWith('[[...segments]]/page.tsx'))!
    expect(admin.content).toBe(`${MARKER}
import '../../../../cms/site.generated'
export { AdminPage as default, generateAdminMetadata as generateMetadata } from '@cms/next/admin'
export const dynamic = 'force-dynamic'
`)
    for (const managed of files) expect(managed.content.startsWith(`${MARKER}\n`)).toBe(true)
  })

  it('works without a src directory', () => {
    const files = managedFiles(config, { srcDir: '' })
    expect(files[0]!.path).toBe('cms/site.generated.ts')
    expect(files[1]).toMatchObject({ path: 'app/(cms)/layout.tsx' })
    expect(files[1]!.content).toContain("import '../../cms/site.generated'")
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
    expect(Object.values(await statuses())).toEqual(Array(7).fill('written'))
    const site = join(root, 'src/cms/site.generated.ts')
    expect(await readFile(site, 'utf8')).toContain('import plugin0 from "@acme/lms"')
    const written = (await stat(site)).mtimeMs

    expect(Object.values(await statuses())).toEqual(Array(7).fill('unchanged'))
    expect((await stat(site)).mtimeMs).toBe(written)

    await writeFile(join(root, 'cms.config.json'), JSON.stringify({ plugins: [] }))
    expect((await statuses())['src/cms/site.generated.ts']).toBe('written')
  })

  it('overwrites edits to a managed file, but keeps a file without the marker', async () => {
    await generate({ root })
    const layout = join(root, 'src/app/(cms)/layout.tsx')
    const page = join(root, 'src/app/(site)/[[...slug]]/page.tsx')
    await writeFile(layout, `${MARKER}\nexport default function Broken() {}\n`)
    await writeFile(page, 'export default function Home() { return "mine" }\n')

    const result = await statuses()
    expect(result['src/app/(cms)/layout.tsx']).toBe('written')
    expect(await readFile(layout, 'utf8')).toContain('AdminRootLayout as default')
    expect(result['src/app/(site)/[[...slug]]/page.tsx']).toBe('kept')
    expect(await readFile(page, 'utf8')).toContain('"mine"')
  })

  it('fails on invalid JSON without writing anything', async () => {
    await writeFile(join(root, 'cms.config.json'), '{ plugins: ')
    await expect(generate({ root })).rejects.toThrow(SyntaxError)
    await expect(stat(join(root, 'src/cms'))).rejects.toThrow('ENOENT')
  })
})
