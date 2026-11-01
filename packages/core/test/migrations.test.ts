import type { Database } from '@otw/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { DatabaseContext } from '../src/database'
import { PluginBootError } from '../src/errors'
import { cmsMigrations, runMigrations } from '../src/migrations'
import { createDb, memoryLogger, plugin } from './helpers'

const createTable = (name: string) => ({
  id: `create_${name}`,
  up: async (db: Database) => {
    await db.execute(sql.raw(`CREATE TABLE ${name} (id serial PRIMARY KEY)`))
  },
})

async function tableExists(db: Database, name: string): Promise<boolean> {
  const rows = await db.execute(sql`SELECT to_regclass(${name}) AS t`)
  return (rows as unknown as { rows: { t: string | null }[] }).rows[0]?.t !== null
}

describe('runMigrations', () => {
  it('applies each plugin migration once, in plugin then array order', async () => {
    const db = createDb()
    const plugins = [
      plugin('commerce', { migrations: [createTable('commerce_a'), createTable('commerce_b')] }),
      plugin('lms', { migrations: [createTable('lms_a')] }),
    ]
    const ran = await runMigrations(new DatabaseContext(db), plugins, memoryLogger())
    expect(ran).toEqual([
      'commerce/create_commerce_a',
      'commerce/create_commerce_b',
      'lms/create_lms_a',
    ])
    expect(await tableExists(db, 'lms_a')).toBe(true)

    const again = await runMigrations(new DatabaseContext(db), plugins, memoryLogger())
    expect(again).toEqual([])
  })

  it('tracks migrations per plugin, so equal ids in different plugins both run', async () => {
    const db = createDb()
    const plugins = [
      plugin('a', {
        migrations: [{ id: '0001', up: async (tx) => tx.execute(sql`CREATE TABLE a_t ()`) }],
      }),
      plugin('b', {
        migrations: [{ id: '0001', up: async (tx) => tx.execute(sql`CREATE TABLE b_t ()`) }],
      }),
    ]
    expect(await runMigrations(new DatabaseContext(db), plugins, memoryLogger())).toHaveLength(2)
  })

  it('runs new migrations added in a later release', async () => {
    const db = createDb()
    await runMigrations(
      new DatabaseContext(db),
      [plugin('a', { migrations: [createTable('a_one')] })],
      memoryLogger(),
    )
    const ran = await runMigrations(
      new DatabaseContext(db),
      [plugin('a', { migrations: [createTable('a_one'), createTable('a_two')] })],
      memoryLogger(),
    )
    expect(ran).toEqual(['a/create_a_two'])
  })

  it('rolls back a failing migration, records nothing and names the plugin', async () => {
    const db = createDb()
    const broken = plugin('broken', {
      migrations: [
        {
          id: 'half_done',
          up: async (tx) => {
            await tx.execute(sql`CREATE TABLE broken_t (id int)`)
            throw new Error('disk full')
          },
        },
      ],
    })
    const error = await runMigrations(new DatabaseContext(db), [broken], memoryLogger()).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(PluginBootError)
    expect(error).toMatchObject({ pluginId: 'broken', phase: 'migrate' })
    expect(await tableExists(db, 'broken_t')).toBe(false)
    expect(await db.select().from(cmsMigrations)).toEqual([])
  })
})
