import { execFile } from 'node:child_process'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createMemoryLogger } from '@otw/core'
import type { Migration } from '@otw/sdk'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/migrate.ts'

const run = promisify(execFile)

const shop = (migrations: Migration[]) => ({ id: 'shop', version: '1.0.0', migrations })
const products: Migration = {
  id: '0001_products',
  up: (db) => db.execute(sql`CREATE TABLE shop_products (id serial PRIMARY KEY)`),
}
const coupons: Migration = {
  id: '0002_coupons',
  up: (db) => db.execute(sql`CREATE TABLE shop_coupons (id serial PRIMARY KEY)`),
}

describe('cms migrate', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cms-migrate-'))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const options = (plugins: ReturnType<typeof shop>[], extra = {}) => ({
    root,
    env: { CMS_DATA_DIR: join(root, '.data', 'pglite') },
    site: { plugins },
    logger: createMemoryLogger(),
    now: () => new Date('2026-11-01T10:00:00.000Z'),
    ...extra,
  })

  it('migrates a new site without a backup, since there is nothing to lose', async () => {
    const result = await migrate(options([shop([products])]))
    expect(result).toEqual({
      applied: ['core/0001_core_tables', 'core/0002_entries', 'shop/0001_products'],
      backup: null,
    })
  })

  it('backs up the embedded database before the next release’s migrations', async () => {
    await migrate(options([shop([products])]))
    expect(await migrate(options([shop([products, coupons])], { dryRun: true }))).toEqual({
      pending: ['shop/0002_coupons'],
    })
    const result = await migrate(options([shop([products, coupons])]))
    const backup = join(root, '.data', 'backups', 'pglite-2026-11-01T10-00-00-000Z')
    expect(result).toEqual({ applied: ['shop/0002_coupons'], backup })
    expect((await readdir(backup)).length).toBeGreaterThan(0)
    expect(await migrate(options([shop([products, coupons])], { dryRun: true }))).toEqual({
      pending: [],
    })
  })

  it('wants a backup of Postgres, or to be told the host takes them', async () => {
    const postgres = options([shop([products])], {
      env: { DATABASE_URL: 'postgres://cms:secret@db.invalid:5432/cms' },
      hasPgDump: async () => false,
    })
    await expect(migrate(postgres)).rejects.toThrow('run `cms migrate --no-backup`')
  })
})

/** The real binary, as a site runs it: tsx loads the CLI, the CMS and the site's plugins. */
describe('the cms binary', () => {
  const bin = resolve(import.meta.dirname, '../bin/cms.js')
  const site = resolve(import.meta.dirname, '../../../apps/web')
  let data: string
  beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'cms-bin-'))
  })
  afterEach(() => rm(data, { recursive: true, force: true }))

  const cms = (...args: string[]) =>
    run(process.execPath, [bin, ...args, '--root', site], {
      env: { ...process.env, CMS_DATA_DIR: join(data, 'pglite'), DATABASE_URL: '' },
    })

  it('lists, applies, then finds nothing left to migrate', { timeout: 60_000 }, async () => {
    const dry = await cms('migrate', '--dry-run')
    expect(dry.stdout).toContain('pending migrations:')
    expect(dry.stdout).toContain('core/0001_core_tables')
    expect(dry.stdout).toMatch(/commerce\/\d{4}_/)
    // A dry run never creates the database.
    await expect(access(join(data, 'pglite'))).rejects.toThrow('ENOENT')

    const applied = await cms('migrate')
    expect(applied.stdout).toMatch(/applied \d+ migration\(s\)/)
    const again = await cms('migrate')
    expect(again.stdout).toContain('backed up the database')
    expect(again.stdout).toContain('the database is up to date')
  })
})
