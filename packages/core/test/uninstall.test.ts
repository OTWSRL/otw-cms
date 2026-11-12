import type { PluginDefinition } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createKernel, type Kernel, type KernelOptions } from '../src/kernel'
import { createDb, formPost, memoryLogger, plugin, redirectOf, signIn } from './helpers'

declare module '@otwdesign/sdk' {
  interface Settings {
    'forum.title': string
    'forum-extra.title': string
  }
  interface Jobs {
    'forum.digest': Record<string, never>
    'forum-extra.digest': Record<string, never>
  }
}

/** A forum with a table, a setting, a job and cached values; `extra` shares its id's start. */
function forum(id: 'forum' | 'forum-extra', uninstall?: PluginDefinition['uninstall']) {
  const table = id.replace('-', '_') + '_topics'
  return plugin(id, {
    name: id === 'forum' ? 'Forum' : 'Forum Extra',
    migrations: [
      { id: '0001_topics', up: (db) => db.execute(sql.raw(`CREATE TABLE ${table} (id serial)`)) },
    ],
    settings: { [`${id}.title`]: { type: 'text', label: 'Title', default: 'Forum' } },
    setup(cms) {
      cms.jobs.define(`${id}.digest` as 'forum.digest', { handler: async () => {} })
    },
    uninstall,
  })
}

const dropTopics: PluginDefinition['uninstall'] = async ({ db }) => {
  await db.execute(sql`DROP TABLE forum_topics`)
}

async function site(definitions: PluginDefinition[], extra: Partial<KernelOptions> = {}) {
  const db = createDb()
  const boot = () =>
    createKernel({
      db,
      plugins: definitions,
      admin: [],
      logger: memoryLogger(),
      strict: true,
      passwordHashing: 'fast',
      ...extra,
    })
  const kernel = await boot()
  const { cookie } = await signIn(kernel)
  // What each plugin leaves behind: a saved setting, a job, a durable cached value.
  for (const { id } of definitions) {
    await kernel.db.execute(
      sql`INSERT INTO cms_settings (key, value) VALUES (${`${id}.title`}, '"Talk"')`,
    )
    if (kernel.isActive(id)) await kernel.jobs.enqueue(`${id}.digest` as 'forum.digest', {})
    await kernel.db.execute(sql`INSERT INTO cms_cache (key, value) VALUES (${`${id}:count`}, '1')`)
  }
  const post = (k: Kernel, name: string, pluginId: string) =>
    k.handleApi(formPost(`/api/p/core/actions/${name}`, { plugin: pluginId }, { cookie }))
  return { boot, kernel, post, cookie }
}

const left = async (kernel: Kernel) => {
  const query = async (text: string) =>
    ((await kernel.db.execute(sql.raw(text))) as unknown as { rows: { v: string }[] }).rows
      .map((row) => row.v)
      .sort()
  return {
    tables: await query(`SELECT tablename AS v FROM pg_tables WHERE tablename LIKE 'forum%'`),
    migrations: await query(
      `SELECT plugin_id AS v FROM cms_migrations WHERE plugin_id LIKE 'forum%'`,
    ),
    settings: await query(`SELECT key AS v FROM cms_settings WHERE key LIKE 'forum%'`),
    jobs: await query(`SELECT name AS v FROM cms_jobs WHERE name LIKE 'forum%'`),
    cached: await query(`SELECT key AS v FROM cms_cache`),
    states: await query(`SELECT id AS v FROM cms_plugins`),
  }
}

describe('deleting a plugin’s data', () => {
  it('needs the plugin deactivated first', async () => {
    const { kernel, post } = await site([forum('forum', dropTopics)])
    const response = await post(kernel, 'delete-plugin-data', 'forum')
    expect(redirectOf(kernel, response).flash).toEqual({
      kind: 'error',
      message: 'Deactivate Forum before deleting its data.',
    })
    expect((await left(kernel)).tables).toEqual(['forum_topics'])
    const unknown = await post(kernel, 'delete-plugin-data', 'nope')
    expect(redirectOf(kernel, unknown).flash?.message).toBe('That plugin is not installed.')
  })

  it('says what it would delete, then deletes it: the plugin’s own and what core kept for it', async () => {
    const { boot, kernel, post } = await site([forum('forum', dropTopics), forum('forum-extra')])
    await post(kernel, 'deactivate-plugin', 'forum')
    const off = await boot()
    expect(await off.uninstallPlan('forum')).toEqual({
      removesItsOwn: true,
      migrations: 1,
      settings: 1,
      jobs: 1,
      cached: 1,
    })
    expect(await off.uninstallPlan('nope')).toBeNull()

    const response = await post(off, 'delete-plugin-data', 'forum')
    expect(redirectOf(off, response)).toMatchObject({
      path: '/admin/plugins',
      flash: { kind: 'notice', message: 'Forum’s data was deleted.' },
    })
    expect(await off.isCurrent()).toBe(false)
    // The other plugin, whose id starts the same, keeps everything.
    expect(await left(off)).toEqual({
      tables: ['forum_extra_topics'],
      migrations: ['forum-extra'],
      settings: ['forum-extra.title'],
      jobs: ['forum-extra.digest'],
      cached: ['forum-extra:count'],
      // Still listed, switched off: a site with no plugin on record is a new one.
      states: ['forum', 'forum-extra'],
    })
  })

  it('lets the plugin be activated again, from nothing', async () => {
    const { boot, kernel, post } = await site([forum('forum', dropTopics)])
    await post(kernel, 'deactivate-plugin', 'forum')
    await post(await boot(), 'delete-plugin-data', 'forum')

    const fresh = await boot()
    expect(fresh.isActive('forum')).toBe(false)
    const activated = await post(fresh, 'activate-plugin', 'forum')
    expect(redirectOf(fresh, activated).flash?.message).toBe('Forum activated.')
    const again = await boot()
    expect(again.isActive('forum')).toBe(true)
    expect(again.setting('forum.title')).toBe('Forum')
    expect((await left(again)).tables).toEqual(['forum_topics'])
  })

  it('leaves the tables of a plugin that doesn’t say how to remove them, and its migrations on record', async () => {
    const { boot, kernel, post } = await site([forum('forum')])
    await post(kernel, 'deactivate-plugin', 'forum')
    const off = await boot()
    expect(await off.uninstallPlan('forum')).toMatchObject({ removesItsOwn: false, migrations: 1 })
    await post(off, 'delete-plugin-data', 'forum')
    expect(await left(off)).toEqual({
      tables: ['forum_topics'],
      migrations: ['forum'],
      settings: [],
      jobs: [],
      cached: [],
      states: ['forum'],
    })
    // Activating it again finds its table as it was.
    const fresh = await boot()
    await post(fresh, 'activate-plugin', 'forum')
    expect((await boot()).isActive('forum')).toBe(true)
  })

  it('deletes nothing when the plugin’s own uninstall fails', async () => {
    const logger = memoryLogger()
    const failing: PluginDefinition['uninstall'] = async ({ db }) => {
      await db.execute(sql`DROP TABLE forum_topics`)
      throw new Error('The archive is locked')
    }
    const { boot, kernel, post } = await site([forum('forum', failing)], { logger })
    await post(kernel, 'deactivate-plugin', 'forum')
    const off = await boot()
    const response = await post(off, 'delete-plugin-data', 'forum')
    expect(redirectOf(off, response).flash).toEqual({
      kind: 'error',
      message: 'Forum’s data could not be deleted, and nothing was: The archive is locked',
    })
    expect(await left(off)).toMatchObject({
      tables: ['forum_topics'],
      migrations: ['forum'],
      settings: ['forum.title'],
      jobs: ['forum.digest'],
      cached: ['forum:count'],
    })
  })

  it('is refused where plugins are pinned, and to those who may not manage plugins', async () => {
    const pinned = await site([forum('forum', dropTopics)], { active: [] })
    const refused = await pinned.post(pinned.kernel, 'delete-plugin-data', 'forum')
    expect(redirectOf(pinned.kernel, refused).flash?.message).toMatch(
      /switched on in the site configuration/,
    )

    const { kernel } = await site([forum('forum', dropTopics)])
    const editor = await signIn(kernel, 'editor')
    const response = await kernel.handleApi(
      formPost(
        '/api/p/core/actions/delete-plugin-data',
        { plugin: 'forum' },
        { cookie: editor.cookie },
      ),
    )
    expect(response.status).toBe(403)
  })
})
