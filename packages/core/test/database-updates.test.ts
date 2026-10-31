import type { Database, Migration, PluginDefinition } from '@cms/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createKernel, type KernelOptions } from '../src/kernel'
import { DatabaseUpdateRequiredError, migrateSite } from '../src/site-migrations'
import { createDb, formPost, memoryLogger, plugin, redirectOf, signIn } from './helpers'

const table = (id: string, name: string): Migration => ({
  id,
  up: (db) => db.execute(sql.raw(`CREATE TABLE ${name} (id serial PRIMARY KEY)`)),
})

/** A shop that ships a second migration in its next release, and a plugin that needs it. */
const shop = (migrations: Migration[]) =>
  plugin('shop', { name: 'Shop', migrations }) satisfies PluginDefinition
const reviews = plugin('reviews', { name: 'Reviews', requires: { shop: '^1.0.0' } })
const V1 = [table('0001_products', 'shop_products')]
const V2 = [...V1, table('0002_coupons', 'shop_coupons')]

function site(db = createDb()) {
  const logger = memoryLogger()
  const boot = (plugins: PluginDefinition[], extra: Partial<KernelOptions> = {}) =>
    createKernel({ db, plugins, logger, passwordHashing: 'fast', ...extra })
  return { db, logger, boot }
}

const tableExists = async (db: Database, name: string) => {
  const result = (await db.execute(sql`SELECT to_regclass(${name}) AS found`)) as {
    rows: { found: string | null }[]
  }
  return result.rows[0]?.found != null
}

describe('migrations at deploy', () => {
  it('keeps a plugin with pending migrations off until the database is updated', async () => {
    const { db, logger, boot } = site()
    await boot([shop(V1), reviews]) // version 1, migrated at startup
    const updated = await boot([shop(V2), reviews], { migrations: 'deploy' })

    expect(updated.active).toEqual([])
    expect(updated.databaseUpdates).toEqual(['shop'])
    expect(updated.skipped).toEqual([
      {
        id: 'shop',
        reason:
          'Needs a database update (shop/0002_coupons). Run `cms migrate`, or update it from the admin.',
      },
      { id: 'reviews', reason: 'requires "shop", which is inactive or failed to load' },
    ])
    expect(await tableExists(db, 'shop_coupons')).toBe(false)
    // Expected during a rolling deploy, so a warning rather than an error.
    expect(logger.entries.filter((entry) => entry.level === 'error')).toEqual([])

    expect(await migrateSite({ db, plugins: [shop(V2), reviews], logger })).toEqual({
      applied: ['shop/0002_coupons'],
    })
    const next = await boot([shop(V2), reviews], { migrations: 'deploy' })
    expect(next.active).toEqual(['shop', 'reviews'])
    expect(next.databaseUpdates).toEqual([])
  })

  it('lets an administrator update the database from the admin', async () => {
    const { db, boot } = site()
    await boot([shop(V1)])
    const kernel = await boot([shop(V2)], { migrations: 'deploy' })
    const update = (cookie: string) =>
      kernel.handleApi(formPost('/api/p/core/actions/update-database', {}, { cookie }))

    const customer = await signIn(kernel, 'customer')
    expect((await update(customer.cookie)).status).toBe(403)
    expect(await tableExists(db, 'shop_coupons')).toBe(false)

    const admin = await signIn(kernel)
    expect(redirectOf(kernel, await update(admin.cookie)).flash).toEqual({
      kind: 'notice',
      message: 'Database updated.',
    })
    expect(await kernel.isCurrent()).toBe(false)
    expect((await boot([shop(V2)], { migrations: 'deploy' })).active).toEqual(['shop'])
  })

  it('migrates a plugin when an administrator activates it', async () => {
    const { db, boot } = site()
    const kernel = await boot([shop(V1)], { migrations: 'deploy', active: undefined }).catch(
      (error: unknown) => error,
    )
    // A fresh database has core's own migrations pending, so nothing boots yet.
    expect(kernel).toBeInstanceOf(DatabaseUpdateRequiredError)
    await migrateSite({ db, plugins: [shop(V1)], logger: memoryLogger() })

    const first = await boot([shop(V1)], { migrations: 'deploy' })
    expect(first.active).toEqual(['shop'])
    const { cookie } = await signIn(first)
    await first.handleApi(
      formPost('/api/p/core/actions/deactivate-plugin', { plugin: 'shop' }, { cookie }),
    )
    // The new release arrives while the plugin is off; switching it on runs its migration.
    const later = await boot([shop(V2)], { migrations: 'deploy' })
    const response = await later.handleApi(
      formPost('/api/p/core/actions/activate-plugin', { plugin: 'shop' }, { cookie }),
    )
    expect(redirectOf(later, response).flash).toEqual({
      kind: 'notice',
      message: 'Shop activated.',
    })
    expect(await tableExists(db, 'shop_coupons')).toBe(true)
  })

  it('refuses to start when core’s own migrations are pending, and says how to fix it', async () => {
    const { boot } = site()
    await expect(boot([shop(V1)], { migrations: 'deploy' })).rejects.toThrow(
      'The database needs updating before the site can start: run `cms migrate`.',
    )
  })

  it('lists pending migrations without running them on a dry run', async () => {
    const { db, boot } = site()
    await boot([shop(V1), reviews])
    const plugins = [shop(V2), reviews]
    expect(await migrateSite({ db, plugins, logger: memoryLogger(), dryRun: true })).toEqual({
      pending: ['shop/0002_coupons'],
    })
    expect(await tableExists(db, 'shop_coupons')).toBe(false)
  })

  it('migrates only active plugins, core first', async () => {
    const { db, boot } = site()
    const first = await boot([shop(V1)])
    const { cookie } = await signIn(first)
    await first.handleApi(
      formPost('/api/p/core/actions/deactivate-plugin', { plugin: 'shop' }, { cookie }),
    )
    // Inactive plugins migrate when they are switched on, as WordPress runs upgrades.
    expect(await migrateSite({ db, plugins: [shop(V2)], logger: memoryLogger() })).toEqual({
      applied: [],
    })
    expect(
      await migrateSite({ db: createDb(), plugins: [shop(V1)], logger: memoryLogger() }),
    ).toEqual({ applied: expect.arrayContaining(['core/0001_core_tables', 'shop/0001_products']) })
  })
})
