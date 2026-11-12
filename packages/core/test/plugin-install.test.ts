import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createKernel, type Kernel, type KernelOptions } from '../src/kernel'
import type { UpdateService } from '../src/updates'
import { createDb, formPost, memoryLogger, plugin, redirectOf, signIn } from './helpers'

/** An update service that records what it was asked to add and remove. */
function hosting(can: { install?: boolean; remove?: boolean } = { install: true, remove: true }) {
  const asked: string[] = []
  const service: UpdateService = {
    overview: async () => ({ channel: 'none' }),
    check: async () => 'Checked.',
    update: async () => 'Updating.',
    rollback: async () => 'Rolled back.',
    setAutoUpdate: async () => 'Saved.',
    ...(can.install
      ? { install: async (name) => (asked.push(`install ${name}`), `Installing ${name}.`) }
      : {}),
    ...(can.remove
      ? { remove: async (name) => (asked.push(`remove ${name}`), `Removing ${name}.`) }
      : {}),
  }
  return { service, asked }
}

const forum = plugin('forum', {
  name: 'Forum',
  migrations: [
    { id: '0001_topics', up: (db) => db.execute(sql`CREATE TABLE forum_topics (id serial)`) },
  ],
  uninstall: async ({ db }) => {
    await db.execute(sql`DROP TABLE forum_topics`)
  },
})

async function site(extra: Partial<KernelOptions> = {}) {
  const db = createDb()
  const boot = () =>
    createKernel({
      db,
      plugins: [forum],
      logger: memoryLogger(),
      strict: true,
      passwordHashing: 'fast',
      ...extra,
    })
  const kernel = await boot()
  const admin = await signIn(kernel)
  const post = (k: Kernel, name: string, fields: Record<string, string>, cookie = admin.cookie) =>
    k.handleApi(formPost(`/api/p/core/actions/${name}`, fields, { cookie }))
  return { boot, kernel, post }
}

const tables = async (kernel: Kernel) =>
  (
    (await kernel.db.execute(
      sql`SELECT tablename FROM pg_tables WHERE tablename = 'forum_topics'`,
    )) as unknown as { rows: unknown[] }
  ).rows.length

describe('installing a plugin from the admin', () => {
  it('asks the site’s hosting to add the package, by its name on npm and nothing else', async () => {
    const { service, asked } = hosting()
    const { kernel, post } = await site({ updates: service })
    const response = await post(kernel, 'install-plugin', { package: ' @acme/wiki ' })
    expect(redirectOf(kernel, response).flash).toEqual({
      kind: 'notice',
      message: 'Installing @acme/wiki.',
    })
    expect(asked).toEqual(['install @acme/wiki'])

    for (const name of ['../evil', '@acme/wiki@latest', 'https://x.test/a.tgz', 'Wiki', '']) {
      const refused = await post(kernel, 'install-plugin', { package: name })
      expect(redirectOf(kernel, refused).flash?.message).toMatch(/^Use the plugin’s package name/)
    }
    expect(asked).toHaveLength(1)
  })

  it('says how to do it by hand where the hosting can’t', async () => {
    for (const updates of [undefined, hosting({}).service]) {
      const { kernel, post } = await site({ updates })
      const response = await post(kernel, 'install-plugin', { package: '@acme/wiki' })
      expect(redirectOf(kernel, response).flash).toMatchObject({
        kind: 'error',
        message: expect.stringContaining('Run `cms plugin add` or `cms plugin remove`'),
      })
    }
  })

  it('is for those who may install plugins: administrators, until a role is granted it', async () => {
    const { service, asked } = hosting()
    const { kernel, post } = await site({ updates: service })
    const editor = await signIn(kernel, 'editor')
    for (const action of ['install-plugin', 'delete-plugin']) {
      const response = await post(
        kernel,
        action,
        { package: '@acme/wiki', plugin: 'forum' },
        editor.cookie,
      )
      expect(response.status).toBe(403)
    }
    expect(asked).toEqual([])
  })
})

describe('deleting a plugin from the admin', () => {
  it('deletes its data, then asks the hosting to remove its package', async () => {
    const { service, asked } = hosting()
    const { boot, kernel, post } = await site({ updates: service })
    // Active: neither happens.
    const active = await post(kernel, 'delete-plugin', { plugin: 'forum', package: '@acme/forum' })
    expect(redirectOf(kernel, active).flash?.message).toBe(
      'Deactivate Forum before deleting its data.',
    )
    expect(asked).toEqual([])

    await post(kernel, 'deactivate-plugin', { plugin: 'forum' })
    const off = await boot()
    expect(await tables(off)).toBe(1)
    const response = await post(off, 'delete-plugin', { plugin: 'forum', package: '@acme/forum' })
    expect(redirectOf(off, response)).toMatchObject({
      path: '/admin/plugins',
      flash: { kind: 'notice', message: 'Forum’s data was deleted. Removing @acme/forum.' },
    })
    expect(await tables(off)).toBe(0)
    expect(asked).toEqual(['remove @acme/forum'])
  })

  it('says so when the data went but the hosting refused to remove the package', async () => {
    const { service } = hosting()
    service.remove = async () => {
      throw new Error('An update is already running. Wait for it to finish.')
    }
    const { boot, kernel, post } = await site({ updates: service })
    await post(kernel, 'deactivate-plugin', { plugin: 'forum' })
    const off = await boot()
    const response = await post(off, 'delete-plugin', { plugin: 'forum', package: '@acme/forum' })
    expect(redirectOf(off, response).flash).toEqual({
      kind: 'error',
      message:
        'Forum’s data was deleted. The plugin itself wasn’t removed: An update is already running. Wait for it to finish.',
    })
    expect(await tables(off)).toBe(0)
  })

  it('deletes nothing where the hosting can’t remove a package', async () => {
    const { boot, kernel, post } = await site({ updates: hosting({ install: true }).service })
    await post(kernel, 'deactivate-plugin', { plugin: 'forum' })
    const off = await boot()
    const response = await post(off, 'delete-plugin', { plugin: 'forum', package: '@acme/forum' })
    expect(redirectOf(off, response).flash?.kind).toBe('error')
    expect(await tables(off)).toBe(1)
  })
})
