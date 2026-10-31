import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MARKER } from '../src/generate.ts'
import { startRelease } from '../src/serve/processes.ts'
import { buildRelease, writeBack } from '../src/serve/releases.ts'
import { backupDatabase, loadState, restoreDatabase, saveState } from '../src/serve/state.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cms-serve-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const write = async (path: string, content: string) => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/** A site with one local plugin, whose build writes a marker into .next. */
async function site() {
  const dir = join(root, 'site')
  await write(
    join(root, 'plugins', 'forum', 'package.json'),
    json({ name: '@acme/forum', version: '1.0.0' }),
  )
  await write(
    join(dir, 'package.json'),
    json({
      name: 'site',
      private: true,
      scripts: {
        build:
          "node -e \"require('fs').mkdirSync('.next');require('fs').writeFileSync('.next/BUILD_ID','1')\"",
      },
      dependencies: { '@acme/forum': 'file:../plugins/forum' },
    }),
  )
  await write(join(dir, 'cms.config.json'), json({ plugins: ['@acme/forum'] }))
  await write(join(dir, '.env'), 'SITE_URL=https://shop.example\n')
  await write(join(dir, 'src', 'cms', 'site.generated.ts'), `${MARKER}\nexport const site = 1\n`)
  await write(join(dir, '.data', 'pglite', 'PG_VERSION'), '17\n')
  await write(join(dir, '.next', 'old'), 'stale')
  return dir
}

describe('buildRelease', () => {
  it(
    'copies the source only, anchors local packages, installs and builds',
    { timeout: 60_000 },
    async () => {
      const dir = await site()
      const lines: string[] = []
      const release = await buildRelease(
        { site: dir, manager: 'npm', releasesDir: join(dir, '.cms', 'releases') },
        'r1',
        [],
        (line) => lines.push(line),
      )
      expect(release).toMatchObject({ id: 'r1', dir: join(dir, '.cms', 'releases', 'r1') })
      expect(release.versions).toEqual({ '@acme/forum': '1.0.0' })
      const files = await readdir(release.dir)
      expect(files).toEqual(expect.arrayContaining(['.env', 'package.json', 'src', 'node_modules']))
      expect(files).not.toContain('.data')
      expect(files).not.toContain('.cms')
      expect(await readFile(join(release.dir, '.next', 'BUILD_ID'), 'utf8')).toBe('1')
      expect(await exists(join(release.dir, '.next', 'old'))).toBe(false)
      const manifest = JSON.parse(await readFile(join(release.dir, 'package.json'), 'utf8'))
      expect(manifest.dependencies['@acme/forum']).toBe(`file:${join(root, 'plugins', 'forum')}`)
      expect(lines).toContain('$ npm install')
      expect(lines).toContain('$ npm run build')
    },
  )

  it('removes a release that fails to build', { timeout: 60_000 }, async () => {
    const dir = await site()
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    manifest.scripts.build = 'node -e "process.exit(3)"'
    await writeFile(join(dir, 'package.json'), json(manifest))
    const releasesDir = join(dir, '.cms', 'releases')
    await expect(
      buildRelease({ site: dir, manager: 'npm', releasesDir }, 'r1', [], () => {}),
    ).rejects.toThrow('npm run exited with 3')
    expect(await exists(join(releasesDir, 'r1'))).toBe(false)
  })
})

describe('writeBack', () => {
  it('brings the new versions and route files back, leaving the site’s own files', async () => {
    const dir = join(root, 'site')
    const release = { id: 'r2', dir: join(root, 'release'), createdAt: '', versions: {} }
    await write(join(dir, 'package.json'), json({ dependencies: { '@acme/forum': '^1.0.0' } }))
    await write(join(dir, 'src', 'app', '(cms)', 'layout.tsx'), `${MARKER}\nold\n`)
    await write(join(dir, 'src', 'app', '(site)', 'layout.tsx'), 'mine\n')
    await write(
      join(release.dir, 'package.json'),
      json({ dependencies: { '@acme/forum': '^1.1.0' } }),
    )
    await write(join(release.dir, 'package-lock.json'), '{"lockfileVersion":3}\n')
    await write(join(release.dir, 'src', 'app', '(cms)', 'layout.tsx'), `${MARKER}\nnew\n`)
    await write(
      join(release.dir, 'src', 'app', '(cms)', 'admin', 'new-file.tsx'),
      `${MARKER}\nadded\n`,
    )
    await write(join(release.dir, 'src', 'app', '(site)', 'layout.tsx'), `${MARKER}\ntemplate\n`)
    await write(join(release.dir, 'node_modules', 'x', 'index.ts'), `${MARKER}\nnot this\n`)

    const skipped = await writeBack({ site: dir, manager: 'npm', releasesDir: '' }, release, [
      { name: '@acme/forum', from: '1.0.0', to: '1.1.0' },
    ])
    expect(skipped).toEqual([])
    expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))).toEqual({
      dependencies: { '@acme/forum': '^1.1.0' },
    })
    expect(await readFile(join(dir, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3}\n')
    expect(await readFile(join(dir, 'src', 'app', '(cms)', 'layout.tsx'), 'utf8')).toContain('new')
    expect(await exists(join(dir, 'src', 'app', '(cms)', 'admin', 'new-file.tsx'))).toBe(true)
    expect(await readFile(join(dir, 'src', 'app', '(site)', 'layout.tsx'), 'utf8')).toBe('mine\n')
    expect(await exists(join(dir, 'node_modules'))).toBe(false)
  })

  it('removes route files the new release no longer has, unless the site owns them', async () => {
    const dir = join(root, 'site')
    const release = { id: 'r2', dir: join(root, 'release'), createdAt: '', versions: {} }
    const retired = join(dir, 'src', 'app', '(site)', '[[...slug]]', 'page.tsx')
    const own = join(dir, 'src', 'app', '(site)', 'about', 'page.tsx')
    await write(join(dir, 'package.json'), json({ dependencies: {} }))
    await write(retired, `${MARKER}\nold catch-all\n`)
    await write(own, 'mine\n')
    await write(join(release.dir, 'package.json'), json({ dependencies: {} }))
    await write(join(release.dir, 'src', 'app', '(site)', 'page.tsx'), `${MARKER}\nhome\n`)

    await writeBack({ site: dir, manager: 'npm', releasesDir: '' }, release, [])
    expect(await exists(join(retired, '..'))).toBe(false)
    expect(await readFile(own, 'utf8')).toBe('mine\n')
    expect(await exists(join(dir, 'src', 'app', '(site)', 'page.tsx'))).toBe(true)
  })

  it('keeps the site’s lockfile when the release anchored local packages', async () => {
    const dir = join(root, 'site')
    const release = { id: 'r2', dir: join(root, 'release'), createdAt: '', versions: {} }
    await write(join(dir, 'package.json'), json({ dependencies: {} }))
    await write(join(dir, 'package-lock.json'), 'site lock\n')
    await write(join(release.dir, 'package.json'), json({ dependencies: { a: 'file:/abs/a' } }))
    await write(join(release.dir, 'package-lock.json'), 'release lock\n')
    expect(await writeBack({ site: dir, manager: 'npm', releasesDir: '' }, release, [])).toEqual([
      'package-lock.json',
    ])
    expect(await readFile(join(dir, 'package-lock.json'), 'utf8')).toBe('site lock\n')
  })
})

describe('state and backups', () => {
  it('starts empty, and saves atomically', async () => {
    const file = join(root, '.cms', 'state.json')
    expect(await loadState(file)).toEqual({
      current: null,
      releases: [],
      autoUpdate: 'off',
      lastCheck: null,
    })
    await saveState(file, { current: 'r1', releases: [], autoUpdate: 'patch', lastCheck: null })
    expect((await loadState(file)).autoUpdate).toBe('patch')
    expect(await readdir(join(root, '.cms'))).toEqual(['state.json'])
  })

  it('copies the embedded database aside, keeps three, and puts one back', async () => {
    const data = join(root, '.data', 'pglite')
    const backups = join(root, '.cms', 'backups')
    await write(join(data, 'PG_VERSION'), 'one')
    let last = ''
    for (let i = 0; i < 4; i++) {
      last = await backupDatabase(data, backups, new Date(Date.UTC(2026, 10, 1, 10, i)))
    }
    expect(await readdir(backups)).toHaveLength(3)
    await writeFile(join(data, 'PG_VERSION'), 'migrated')
    await restoreDatabase(last, data)
    expect(await readFile(join(data, 'PG_VERSION'), 'utf8')).toBe('one')
  })
})

describe('startRelease', () => {
  /** A release whose `next` is a tiny server, or a script that fails. */
  async function release(script: string) {
    const dir = join(root, 'release')
    await write(join(dir, 'node_modules', 'next', 'dist', 'bin', 'next'), script)
    return { id: 'r1', dir, createdAt: '', versions: {} }
  }

  it('resolves once the release answers, passing it the environment', async () => {
    const served = await release(`
      require('node:http').createServer((req, res) => {
        res.writeHead(req.url === '/admin/login' ? 200 : 404, { 'x-env': process.env.CMS_SUPERVISOR_URL })
        res.end(process.argv.slice(2).join(' '))
      }).listen(Number(process.env.PORT), '127.0.0.1')
    `)
    const running = await startRelease(served, () => {}, {
      env: { CMS_SUPERVISOR_URL: 'http://127.0.0.1:1' },
      output: () => {},
    })
    const response = await fetch(`http://127.0.0.1:${running.port}/admin/login`)
    expect(response.headers.get('x-env')).toBe('http://127.0.0.1:1')
    expect(await response.text()).toBe(`start --port ${running.port} --hostname 127.0.0.1`)
    await running.stop()
    await expect(fetch(`http://127.0.0.1:${running.port}/admin/login`)).rejects.toThrow()
  })

  it('rejects when the release exits or never answers', async () => {
    const crashing = await release(`console.error('Cannot find module x'); process.exit(1)`)
    const lines: string[] = []
    await expect(
      startRelease(crashing, (line) => lines.push(line), { env: {}, output: () => {} }),
    ).rejects.toThrow('The release r1 exited (code 1) before it answered.')
    expect(lines).toContain('[r1] Cannot find module x')

    const silent = await release(`setInterval(() => {}, 1000)`)
    await expect(
      startRelease(silent, () => {}, { env: {}, output: () => {}, timeoutMs: 1_000, graceMs: 500 }),
    ).rejects.toThrow('did not answer within 1 seconds')
  })
})
